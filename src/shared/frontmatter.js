import JSON5 from "json5";
import { LEGACY_MANIFEST_KEYS, MANIFEST_KEY } from "../compat/legacy-names.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { normalizeOptionalLowercaseString, readStringValue } from "./string-coerce.js";
import { normalizeCsvOrLooseStringList } from "./string-normalization.js";
export function normalizeStringList(input) {
    return normalizeCsvOrLooseStringList(input);
}
export function getFrontmatterString(frontmatter, key) {
    return readStringValue(frontmatter[key]);
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
    const kind = normalizeOptionalLowercaseString(kindRaw) ?? "";
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
export function applyOpenClawManifestInstallCommonFields(spec, parsed) {
    if (parsed.id) {
        spec.id = parsed.id;
    }
    if (parsed.label) {
        spec.label = parsed.label;
    }
    if (parsed.bins) {
        spec.bins = parsed.bins;
    }
    return spec;
}
