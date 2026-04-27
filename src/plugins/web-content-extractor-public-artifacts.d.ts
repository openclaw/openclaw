import type { PluginWebContentExtractorEntry } from "./web-content-extractor-types.js";
export declare function loadBundledWebContentExtractorEntriesFromDir(params: {
    dirName: string;
    pluginId: string;
}): PluginWebContentExtractorEntry[] | null;
export declare function hasBundledWebContentExtractorPublicArtifact(pluginId: string): boolean;
