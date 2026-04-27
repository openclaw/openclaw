import type { PluginPackageChannel } from "../plugins/manifest.js";
export type BundledChannelCatalogEntry = {
    id: string;
    channel: PluginPackageChannel;
    aliases: readonly string[];
    order: number;
};
export declare function listBundledChannelCatalogEntries(): BundledChannelCatalogEntry[];
