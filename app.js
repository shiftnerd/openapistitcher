/* OpenAPI Combiner (static)
 * - Loads multiple OpenAPI JSON/YAML files
 * - Merges paths/components/tags/servers/security
 * - Renames conflicting component keys and rewrites $refs inside the incoming spec
 */

const els = {
    btnCombine: document.getElementById("btnCombine"),
    btnDownload: document.getElementById("btnDownload"),
    output: document.getElementById("output"),
    summary: document.getElementById("summary"),
    log: document.getElementById("log"),

    // GitHub
    ghOwner: document.getElementById("ghOwner"),
    ghRepo: document.getElementById("ghRepo"),
    ghPath: document.getElementById("ghPath"),
    ghRef: document.getElementById("ghRef"),
    btnListGithub: document.getElementById("btnListGithub"),
    ghStatus: document.getElementById("ghStatus"),
    ghFileList: document.getElementById("ghFileList"),
    btnAddSelectedGithub: document.getElementById("btnAddSelectedGithub"),

    // Upload
    fileInput: document.getElementById("fileInput"),
    dropzone: document.getElementById("dropzone"),

    // Selected
    selectedList: document.getElementById("selectedList"),
    btnClear: document.getElementById("btnClear"),

    // Options
    outFormat: document.getElementById("outFormat"),
    pathConflict: document.getElementById("pathConflict"),
    componentConflict: document.getElementById("componentConflict"),
    prefixMode: document.getElementById("prefixMode"),
    baseTitle: document.getElementById("baseTitle"),
    baseVersion: document.getElementById("baseVersion"),
};

const state = {
    sources: [], // { id, label, kind: 'github'|'local', filename, text, parsed, openapi, warnings[] }
    githubListed: [], // [{name, download_url, path, size}]
    githubSelected: new Set(),
    lastCombined: null, // { doc, text, filename, mime }
};

function log(line) {
    const ts = new Date().toISOString().slice(11, 19);
    els.log.textContent += `[${ts}] ${line}\n`;
    els.log.scrollTop = els.log.scrollHeight;
}

function clearLog() {
    els.log.textContent = "";
}

function setStatus(el, msg, good = null) {
    el.textContent = msg || "";
    if (good === true) el.style.color = "rgba(34,197,94,0.95)";
    else if (good === false) el.style.color = "rgba(239,68,68,0.95)";
    else el.style.color = "";
}

function sanitizePrefix(str) {
    return String(str)
        .replace(/\.[^.]+$/, "") // drop extension
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "src";
}

function prettyBytes(bytes) {
    if (!Number.isFinite(bytes)) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function deepClone(obj) {
    return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}

function deepEqual(a, b) {
    // good-enough structural comparison for JSON-ish values
    return JSON.stringify(a) === JSON.stringify(b);
}

function isObject(v) {
    return v && typeof v === "object" && !Array.isArray(v);
}

function parseSpecText(text, filename = "spec") {
    const trimmed = text.trim();
    // Try JSON first if it looks like JSON
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return JSON.parse(trimmed);
    }
    // Else YAML
    return jsyaml.load(text);
}

function detectOpenApiVersion(doc) {
    const v = doc && doc.openapi ? String(doc.openapi) : "";
    return v;
}

function ensureArray(v) {
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
}

function uniqBy(arr, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of arr) {
        const k = keyFn(item);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(item);
    }
    return out;
}

function normalizeServers(servers) {
    return ensureArray(servers)
        .filter(Boolean)
        .map(s => (typeof s === "string" ? { url: s } : s))
        .filter(s => s && s.url);
}

function normalizeTags(tags) {
    return ensureArray(tags)
        .filter(Boolean)
        .map(t => (typeof t === "string" ? { name: t } : t))
        .filter(t => t && t.name);
}

function updateUI() {
    els.selectedList.innerHTML = "";
    if (state.sources.length === 0) {
        els.selectedList.innerHTML = `<div class="muted">No sources selected.</div>`;
    } else {
        for (const src of state.sources) {
            const row = document.createElement("div");
            row.className = "selrow";
            const left = document.createElement("div");
            left.style.display = "flex";
            left.style.gap = "10px";
            left.style.alignItems = "center";
            left.style.minWidth = "0";

            const name = document.createElement("div");
            name.className = "filename";
            name.textContent = src.filename || src.label || src.id;

            const pill = document.createElement("span");
            pill.className = "pill";
            pill.textContent = src.kind === "github" ? "GitHub" : "Local";

            const pill2 = document.createElement("span");
            const warnCount = (src.warnings || []).length;
            pill2.className = `pill ${warnCount ? "warn" : "ok"}`;
            pill2.textContent = warnCount ? `${warnCount} warning${warnCount === 1 ? "" : "s"}` : "OK";

            left.appendChild(pill);
            left.appendChild(pill2);
            left.appendChild(name);

            const right = document.createElement("div");
            right.style.display = "flex";
            right.style.gap = "8px";
            const btn = document.createElement("button");
            btn.className = "btn";
            btn.textContent = "Remove";
            btn.onclick = () => {
                state.sources = state.sources.filter(s => s.id !== src.id);
                updateUI();
            };
            right.appendChild(btn);

            row.appendChild(left);
            row.appendChild(right);
            els.selectedList.appendChild(row);
        }
    }

    els.btnClear.disabled = state.sources.length === 0;
    els.btnDownload.disabled = !state.lastCombined;
}

function addSource({ kind, filename, label, text }) {
    const id = `${kind}:${crypto.randomUUID()}`;
    const warnings = [];
    let parsed = null;
    let openapi = "";
    try {
        parsed = parseSpecText(text, filename);
        openapi = detectOpenApiVersion(parsed);
        if (!openapi) warnings.push("Missing 'openapi' field");
        if (!parsed.paths) warnings.push("Missing 'paths' field");
    } catch (e) {
        warnings.push(`Parse error: ${e.message}`);
    }

    state.sources.push({ id, kind, filename, label, text, parsed, openapi, warnings });
    log(`Added source: ${filename} (${kind})`);
    updateUI();
}

function clearAll() {
    state.sources = [];
    state.githubListed = [];
    state.githubSelected.clear();
    state.lastCombined = null;
    els.output.value = "";
    els.summary.innerHTML = `<span class="muted">Add some sources, then click <b>Combine</b>.</span>`;
    els.ghFileList.innerHTML = "";
    els.btnAddSelectedGithub.disabled = true;
    updateUI();
    log("Cleared all sources.");
}

/** ----------------------------
 * GitHub listing & selection
 * ---------------------------*/
async function listGithubFiles() {
    const owner = els.ghOwner.value.trim();
    const repo = els.ghRepo.value.trim();
    const path = els.ghPath.value.trim().replace(/^\/+|\/+$/g, "");
    const ref = els.ghRef.value.trim() || "main";

    if (!owner || !repo) {
        setStatus(els.ghStatus, "Owner + Repo required.", false);
        return;
    }

    setStatus(els.ghStatus, "Listing…");
    els.ghFileList.innerHTML = "";
    state.githubListed = [];
    state.githubSelected.clear();
    els.btnAddSelectedGithub.disabled = true;

    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;

    try {
        const res = await fetch(url, {
            headers: {
                "Accept": "application/vnd.github+json"
            }
        });
        if (!res.ok) {
            const t = await res.text();
            throw new Error(`GitHub API error ${res.status}: ${t.slice(0, 200)}`);
        }
        const data = await res.json();
        if (!Array.isArray(data)) {
            throw new Error("Path did not resolve to a folder listing.");
        }

        // keep only likely spec files
        const files = data
            .filter(x => x && x.type === "file")
            .map(x => ({
                name: x.name,
                path: x.path,
                download_url: x.download_url,
                size: x.size
            }))
            .filter(x => /\.(json|ya?ml)$/i.test(x.name));

        state.githubListed = files;

        if (files.length === 0) {
            setStatus(els.ghStatus, "No .json/.yaml files found in that folder.", false);
            return;
        }

        renderGithubFileList(files);
        setStatus(els.ghStatus, `Found ${files.length} spec file(s).`, true);
    } catch (e) {
        setStatus(els.ghStatus, e.message, false);
        log(`GitHub list failed: ${e.message}`);
    }
}

function renderGithubFileList(files) {
    els.ghFileList.innerHTML = "";

    const topRow = document.createElement("div");
    topRow.className = "fileitem";
    topRow.innerHTML = `
    <div class="fileleft">
      <input type="checkbox" id="ghSelectAll" />
      <div class="filename">Select all</div>
    </div>
    <div class="filemeta">${files.length} files</div>
  `;
    els.ghFileList.appendChild(topRow);

    const selectAll = topRow.querySelector("#ghSelectAll");
    selectAll.addEventListener("change", () => {
        state.githubSelected.clear();
        if (selectAll.checked) {
            for (const f of files) state.githubSelected.add(f.path);
        }
        // update all checkboxes
        els.ghFileList.querySelectorAll("input[data-path]").forEach(cb => {
            cb.checked = selectAll.checked;
        });
        els.btnAddSelectedGithub.disabled = state.githubSelected.size === 0;
    });

    for (const f of files) {
        const row = document.createElement("div");
        row.className = "fileitem";

        const left = document.createElement("div");
        left.className = "fileleft";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.path = f.path;
        cb.addEventListener("change", () => {
            if (cb.checked) state.githubSelected.add(f.path);
            else state.githubSelected.delete(f.path);

            // set selectAll if everything is checked
            selectAll.checked = state.githubSelected.size === files.length;
            els.btnAddSelectedGithub.disabled = state.githubSelected.size === 0;
        });

        const name = document.createElement("div");
        name.className = "filename";
        name.textContent = f.name;

        left.appendChild(cb);
        left.appendChild(name);

        const meta = document.createElement("div");
        meta.className = "filemeta";
        meta.textContent = prettyBytes(f.size);

        row.appendChild(left);
        row.appendChild(meta);

        els.ghFileList.appendChild(row);
    }
}

async function addSelectedGithub() {
    const selectedPaths = [...state.githubSelected];
    if (selectedPaths.length === 0) return;

    const filesByPath = new Map(state.githubListed.map(f => [f.path, f]));
    log(`Downloading ${selectedPaths.length} GitHub file(s)…`);

    for (const p of selectedPaths) {
        const file = filesByPath.get(p);
        if (!file || !file.download_url) continue;
        try {
            const res = await fetch(file.download_url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            addSource({
                kind: "github",
                filename: file.name,
                label: file.path,
                text
            });
        } catch (e) {
            log(`Failed to download ${file.name}: ${e.message}`);
        }
    }
}

/** ----------------------------
 * Local upload / drag drop
 * ---------------------------*/
function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    files.forEach(async (f) => {
        try {
            const text = await f.text();
            addSource({ kind: "local", filename: f.name, label: f.name, text });
        } catch (e) {
            log(`Failed to read ${f.name}: ${e.message}`);
        }
    });
}

/** ----------------------------
 * Merge logic
 * ---------------------------*/
const COMPONENT_SECTIONS = [
    "schemas",
    "responses",
    "parameters",
    "requestBodies",
    "headers",
    "securitySchemes",
    "examples",
    "links",
    "callbacks"
];

function makeEmptyBase(openapiVersion = "3.0.0") {
    return {
        openapi: openapiVersion,
        info: { title: "Combined OpenAPI", version: "1.0.0" },
        paths: {},
        components: {}
    };
}

function mergeAll() {
    clearLog();
    state.lastCombined = null;
    els.output.value = "";

    if (state.sources.length === 0) {
        log("No sources selected.");
        return;
    }

    // Validate and filter parseable sources
    const usable = state.sources.filter(s => s.parsed && isObject(s.parsed));
    const bad = state.sources.filter(s => !s.parsed || !isObject(s.parsed));
    if (bad.length) {
        log(`Skipping ${bad.length} unparseable source(s).`);
    }
    if (usable.length === 0) {
        log("No usable sources to combine.");
        return;
    }

    const openapiTarget = usable.find(s => s.openapi)?.openapi || usable[0].openapi || "3.0.0";
    let out = makeEmptyBase(openapiTarget);

    // Base title/version overrides
    const baseTitle = els.baseTitle.value.trim();
    const baseVersion = els.baseVersion.value.trim();
    if (baseTitle) out.info.title = baseTitle;
    if (baseVersion) out.info.version = baseVersion;

    const pathConflict = els.pathConflict.value; // prefer-first | prefer-last
    const componentConflict = els.componentConflict.value; // rename | overwrite | keep
    const prefixMode = els.prefixMode.value; // filename | index

    // Collect warnings about openapi mismatches
    for (const s of usable) {
        if (s.openapi && s.openapi !== openapiTarget) {
            log(`WARN: ${s.filename} has openapi=${s.openapi} (target=${openapiTarget}).`);
        }
    }

    // Merge in order
    usable.forEach((src, idx) => {
        const doc = deepClone(src.parsed);
        const prefix = prefixMode === "index" ? `src${idx + 1}` : sanitizePrefix(src.filename || `src${idx + 1}`);
        log(`Merging ${src.filename} (prefix=${prefix})…`);

        // Merge top-level: servers, tags, security, externalDocs (first wins)
        out.servers = uniqBy(
            [...normalizeServers(out.servers), ...normalizeServers(doc.servers)],
            s => s.url
        );
        out.tags = uniqBy(
            [...normalizeTags(out.tags), ...normalizeTags(doc.tags)],
            t => t.name
        );

        if (!out.security && doc.security) out.security = deepClone(doc.security);
        if (!out.externalDocs && doc.externalDocs) out.externalDocs = deepClone(doc.externalDocs);

        // Merge paths
        out.paths = out.paths || {};
        const incomingPaths = doc.paths || {};
        for (const [p, pathItem] of Object.entries(incomingPaths)) {
            if (!out.paths[p]) {
                out.paths[p] = deepClone(pathItem);
                continue;
            }
            // merge methods under same path
            const existing = out.paths[p];
            for (const [k, v] of Object.entries(pathItem || {})) {
                const lk = k.toLowerCase();
                const isMethod = ["get", "put", "post", "delete", "options", "head", "patch", "trace"].includes(lk);
                if (!isMethod) {
                    // parameters, summary, etc: keep existing unless prefer-last
                    if (pathConflict === "prefer-last") existing[k] = deepClone(v);
                    continue;
                }
                if (!existing[k]) {
                    existing[k] = deepClone(v);
                } else {
                    if (pathConflict === "prefer-last") {
                        existing[k] = deepClone(v);
                    } else {
                        // keep existing
                    }
                }
            }
        }

        // Merge components with conflict handling
        out.components = out.components || {};
        doc.components = doc.components || {};

        // If we need to rename conflicts, do it per component section
        for (const section of COMPONENT_SECTIONS) {
            const incomingSection = doc.components[section];
            if (!incomingSection || !isObject(incomingSection)) continue;
            out.components[section] = out.components[section] || {};

            // Build rename map for this section: { oldKey: newKey }
            const renameMap = {};

            for (const [key, val] of Object.entries(incomingSection)) {
                const exists = Object.prototype.hasOwnProperty.call(out.components[section], key);
                if (!exists) continue;

                const same = deepEqual(out.components[section][key], val);
                if (same) {
                    // identical; no action needed
                    continue;
                }

                if (componentConflict === "overwrite") {
                    // will overwrite below
                    continue;
                }
                if (componentConflict === "keep") {
                    // will skip below
                    continue;
                }

                // rename
                let candidate = `${prefix}_${key}`;
                let i = 2;
                while (Object.prototype.hasOwnProperty.call(out.components[section], candidate) ||
                    Object.prototype.hasOwnProperty.call(incomingSection, candidate)) {
                    candidate = `${prefix}_${key}_${i++}`;
                }
                renameMap[key] = candidate;
                log(`  Component conflict in ${section}: ${key} → ${candidate}`);
            }

            // Rewrite $refs in incoming doc for this section if renaming
            if (componentConflict === "rename" && Object.keys(renameMap).length) {
                rewriteRefs(doc, section, renameMap);
                // also rewrite inside incoming section itself (keys will be moved below)
            }

            // Apply merge (with potential rename)
            for (const [key, val] of Object.entries(incomingSection)) {
                const exists = Object.prototype.hasOwnProperty.call(out.components[section], key);

                if (!exists) {
                    out.components[section][key] = deepClone(val);
                    continue;
                }

                const same = deepEqual(out.components[section][key], val);
                if (same) {
                    continue;
                }

                if (componentConflict === "overwrite") {
                    out.components[section][key] = deepClone(val);
                    continue;
                }

                if (componentConflict === "keep") {
                    continue;
                }

                // rename mode: put under renamed key (if mapped) else keep as-is
                const newKey = renameMap[key];
                if (newKey) out.components[section][newKey] = deepClone(val);
                else {
                    // If it wasn't mapped, it means it wasn't a true conflict or was identical
                    // but we are here due to logic; keep existing
                }
            }
        }

        // Merge other helpful top-level fields (first wins to avoid surprises)
        if (!out.securitySchemes && doc.securitySchemes) out.securitySchemes = deepClone(doc.securitySchemes);
        // Info: if user didn't override title/version, keep first doc's info title/version if base is default.
        if (!baseTitle && out.info && out.info.title === "Combined OpenAPI" && doc.info?.title) out.info.title = doc.info.title;
        if (!baseVersion && out.info && out.info.version === "1.0.0" && doc.info?.version) out.info.version = doc.info.version;

        // Merge "components" extensions or vendor extensions at root (x-*)
        for (const [k, v] of Object.entries(doc)) {
            if (k.startsWith("x-") && out[k] === undefined) out[k] = deepClone(v);
        }
    });

    // Clean empty components
    if (out.components && Object.keys(out.components).length === 0) delete out.components;

    const outFormat = els.outFormat.value;
    let text;
    if (outFormat === "json") {
        text = JSON.stringify(out, null, 2);
    } else {
        text = jsyaml.dump(out, { noRefs: true, lineWidth: 120 });
    }

    state.lastCombined = {
        doc: out,
        text,
        filename: `openapi-combined.${outFormat === "json" ? "json" : "yaml"}`,
        mime: outFormat === "json" ? "application/json" : "application/yaml"
    };

    els.output.value = text;
    els.btnDownload.disabled = false;

    const pathCount = countPaths(out);
    const compCount = countComponents(out);
    els.summary.innerHTML = `
    <div><b>Sources:</b> ${state.sources.length} (${usable.length} usable)</div>
    <div><b>OpenAPI:</b> ${out.openapi || "?"}</div>
    <div><b>Paths:</b> ${pathCount.paths}  •  <b>Operations:</b> ${pathCount.ops}</div>
    <div><b>Components:</b> ${compCount.total} (${compCount.breakdown})</div>
    <div class="muted">Tip: if component naming conflicts happen, “Auto-rename” prefixes them and rewrites incoming $refs.</div>
  `;

    log("Combine complete.");
    updateUI();
}

function countPaths(doc) {
    const paths = doc.paths || {};
    let ops = 0;
    let pcount = 0;
    for (const [p, item] of Object.entries(paths)) {
        pcount++;
        for (const m of Object.keys(item || {})) {
            const lk = m.toLowerCase();
            if (["get", "put", "post", "delete", "options", "head", "patch", "trace"].includes(lk)) ops++;
        }
    }
    return { paths: pcount, ops };
}

function countComponents(doc) {
    const c = doc.components || {};
    let total = 0;
    const parts = [];
    for (const s of COMPONENT_SECTIONS) {
        const n = c[s] ? Object.keys(c[s]).length : 0;
        if (n) parts.push(`${s}:${n}`);
        total += n;
    }
    return { total, breakdown: parts.length ? parts.join(", ") : "none" };
}

/**
 * Rewrite $refs in incoming doc that reference #/components/<section>/<key>
 * to the renamed key.
 *
 * This traverses the entire incoming doc (paths, components, etc.), not just that section,
 * because $refs to schemas/parameters/etc appear everywhere.
 */
function rewriteRefs(doc, section, renameMap) {
    const prefix = `#/components/${section}/`;
    traverse(doc, (node, path) => {
        if (!isObject(node)) return;

        if (typeof node.$ref === "string" && node.$ref.startsWith(prefix)) {
            const oldKey = node.$ref.slice(prefix.length);
            if (renameMap[oldKey]) {
                node.$ref = `${prefix}${renameMap[oldKey]}`;
            }
        }
    });

    // Also rename actual keys within doc.components[section] to match renamed names
    const sec = doc.components?.[section];
    if (sec && isObject(sec)) {
        for (const [oldKey, newKey] of Object.entries(renameMap)) {
            if (Object.prototype.hasOwnProperty.call(sec, oldKey)) {
                sec[newKey] = sec[oldKey];
                delete sec[oldKey];
            }
        }
    }
}

function traverse(value, fn, path = []) {
    fn(value, path);
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) traverse(value[i], fn, path.concat(i));
    } else if (isObject(value)) {
        for (const [k, v] of Object.entries(value)) traverse(v, fn, path.concat(k));
    }
}

/** ----------------------------
 * Download
 * ---------------------------*/
function downloadCombined() {
    if (!state.lastCombined) return;
    const { text, filename, mime } = state.lastCombined;

    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log(`Downloaded ${filename}`);
}

/** ----------------------------
 * Events
 * ---------------------------*/
els.btnListGithub.addEventListener("click", listGithubFiles);
els.btnAddSelectedGithub.addEventListener("click", addSelectedGithub);

els.fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

els.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragover");
});
els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragover"));
els.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragover");
    handleFiles(e.dataTransfer.files);
});

els.btnCombine.addEventListener("click", mergeAll);
els.btnDownload.addEventListener("click", downloadCombined);

els.btnClear.addEventListener("click", clearAll);

// initial UI
updateUI();
log("Ready. Add sources (GitHub or local) and click Combine.");
