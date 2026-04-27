import { type BundledPluginMetadata } from "./bundled-plugin-metadata.js";
export type BundledChannelPluginMetadata = BundledPluginMetadata;
export declare function listBundledChannelPluginMetadata(params?: {
    rootDir?: string;
    scanDir?: string;
    includeChannelConfigs?: boolean;
    includeSyntheticChannelConfigs?: boolean;
}): readonly BundledChannelPluginMetadata[];
export declare function resolveBundledChannelGeneratedPath(rootDir: string, entry: BundledPluginMetadata["source"] | BundledPluginMetadata["setupSource"], pluginDirName?: string, scanDir?: string): string | null;
export declare function resolveBundledChannelWorkspacePath(params: {
    rootDir: string;
    scanDir?: string;
    pluginId: string;
}): string | null;
