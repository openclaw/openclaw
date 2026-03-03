import fs from "node:fs";
import path from "node:path";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
export const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
export const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME];
function normalizeStringList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}
export function resolvePluginManifestPath(rootDir) {
    for (const filename of PLUGIN_MANIFEST_FILENAMES) {
        const candidate = path.join(rootDir, filename);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}
export function loadPluginManifest(rootDir) {
    const manifestPath = resolvePluginManifestPath(rootDir);
    const opened = openBoundaryFileSync({
        absolutePath: manifestPath,
        rootPath: rootDir,
        boundaryLabel: "plugin root",
    });
    if (!opened.ok) {
        if (opened.reason === "path") {
            return { ok: false, error: `plugin manifest not found: ${manifestPath}`, manifestPath };
        }
        return {
            ok: false,
            error: `unsafe plugin manifest path: ${manifestPath} (${opened.reason})`,
            manifestPath,
        };
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8"));
    }
    catch (err) {
        return {
            ok: false,
            error: `failed to parse plugin manifest: ${String(err)}`,
            manifestPath,
        };
    }
    finally {
        fs.closeSync(opened.fd);
    }
    if (!isRecord(raw)) {
        return { ok: false, error: "plugin manifest must be an object", manifestPath };
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
        return { ok: false, error: "plugin manifest requires id", manifestPath };
    }
    const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
    if (!configSchema) {
        return { ok: false, error: "plugin manifest requires configSchema", manifestPath };
    }
    const kind = typeof raw.kind === "string" ? raw.kind : undefined;
    const name = typeof raw.name === "string" ? raw.name.trim() : undefined;
    const description = typeof raw.description === "string" ? raw.description.trim() : undefined;
    const version = typeof raw.version === "string" ? raw.version.trim() : undefined;
    const channels = normalizeStringList(raw.channels);
    const providers = normalizeStringList(raw.providers);
    const skills = normalizeStringList(raw.skills);
    let uiHints;
    if (isRecord(raw.uiHints)) {
        uiHints = raw.uiHints;
    }
    return {
        ok: true,
        manifest: {
            id,
            configSchema,
            kind,
            channels,
            providers,
            skills,
            name,
            description,
            version,
            uiHints,
        },
        manifestPath,
    };
}
export function getPackageManifestMetadata(manifest) {
    if (!manifest) {
        return undefined;
    }
    return manifest[MANIFEST_KEY];
}
