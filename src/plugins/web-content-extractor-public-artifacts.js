import { loadBundledPluginPublicArtifactModuleSync, resolveBundledPluginPublicArtifactPath, } from "./public-surface-loader.js";
const WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES = [
    "web-content-extractor.js",
    "web-content-extractor-api.js",
];
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isWebContentExtractorPlugin(value) {
    return (isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.label === "string" &&
        (value.autoDetectOrder === undefined || typeof value.autoDetectOrder === "number") &&
        typeof value.extract === "function");
}
function tryLoadBundledPublicArtifactModule(params) {
    for (const artifactBasename of WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES) {
        try {
            return loadBundledPluginPublicArtifactModuleSync({
                dirName: params.dirName,
                artifactBasename,
            });
        }
        catch (error) {
            if (error instanceof Error &&
                error.message.startsWith("Unable to resolve bundled plugin public surface ")) {
                continue;
            }
            throw error;
        }
    }
    return null;
}
function collectExtractorFactories(mod) {
    const extractors = [];
    for (const [name, exported] of Object.entries(mod).toSorted(([left], [right]) => left.localeCompare(right))) {
        if (typeof exported !== "function" ||
            exported.length !== 0 ||
            !name.startsWith("create") ||
            !name.endsWith("WebContentExtractor")) {
            continue;
        }
        const candidate = exported();
        if (isWebContentExtractorPlugin(candidate)) {
            extractors.push(candidate);
        }
    }
    return extractors;
}
export function loadBundledWebContentExtractorEntriesFromDir(params) {
    const mod = tryLoadBundledPublicArtifactModule({ dirName: params.dirName });
    if (!mod) {
        return null;
    }
    const extractors = collectExtractorFactories(mod);
    if (extractors.length === 0) {
        return null;
    }
    return extractors.map((extractor) => Object.assign({}, extractor, { pluginId: params.pluginId }));
}
export function hasBundledWebContentExtractorPublicArtifact(pluginId) {
    return WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES.some((artifactBasename) => Boolean(resolveBundledPluginPublicArtifactPath({ dirName: pluginId, artifactBasename })));
}
