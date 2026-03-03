import JSON5 from "json5";
import { LEGACY_MANIFEST_KEYS, MANIFEST_KEY } from "../compat/legacy-names.js";
import { parseBooleanValue } from "../utils/boolean.js";
export function normalizeStringList(input) {
    if (!input) {
        return [];
    }
    if (Array.isArray(input)) {
        return input.map((value) => String(value).trim()).filter(Boolean);
    }
    if (typeof input === "string") {
        return input
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
    }
    return [];
}
export function getFrontmatterString(frontmatter, key) {
    const raw = frontmatter[key];
    return typeof raw === "string" ? raw : undefined;
}
export function parseFrontmatterBool(value, fallback) {
    const parsed = parseBooleanValue(value);
    return parsed === undefined ? fallback : parsed;
}
export function resolveOpenClawManifestBlock(params) {
    const raw = getFrontmatterString(params.frontmatter, params.key ?? "metadata");
    if (!raw) {
        return undefined;
    }
    try {
        const parsed = JSON5.parse(raw);
        if (!parsed || typeof parsed !== "object") {
            return undefined;
        }
        const manifestKeys = [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS];
        for (const key of manifestKeys) {
            const candidate = parsed[key];
            if (candidate && typeof candidate === "object") {
                return candidate;
            }
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
export function resolveOpenClawManifestRequires(metadataObj) {
    const requiresRaw = typeof metadataObj.requires === "object" && metadataObj.requires !== null
        ? metadataObj.requires
        : undefined;
    if (!requiresRaw) {
        return undefined;
    }
    return {
        bins: normalizeStringList(requiresRaw.bins),
        anyBins: normalizeStringList(requiresRaw.anyBins),
        env: normalizeStringList(requiresRaw.env),
        config: normalizeStringList(requiresRaw.config),
    };
}
export function resolveOpenClawManifestInstall(metadataObj, parseInstallSpec) {
    const installRaw = Array.isArray(metadataObj.install) ? metadataObj.install : [];
    return installRaw
        .map((entry) => parseInstallSpec(entry))
        .filter((entry) => Boolean(entry));
}
export function resolveOpenClawManifestOs(metadataObj) {
    return normalizeStringList(metadataObj.os);
}
export function parseOpenClawManifestInstallBase(input, allowedKinds) {
    if (!input || typeof input !== "object") {
        return undefined;
    }
    const raw = input;
    const kindRaw = typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "";
    const kind = kindRaw.trim().toLowerCase();
    if (!allowedKinds.includes(kind)) {
        return undefined;
    }
    const spec = {
        raw,
        kind,
    };
    if (typeof raw.id === "string") {
        spec.id = raw.id;
    }
    if (typeof raw.label === "string") {
        spec.label = raw.label;
    }
    const bins = normalizeStringList(raw.bins);
    if (bins.length > 0) {
        spec.bins = bins;
    }
    return spec;
}
