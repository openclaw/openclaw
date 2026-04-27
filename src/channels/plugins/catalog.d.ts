import { type PluginInstallSourceInfo } from "../../plugins/install-source-info.js";
import type { PluginPackageInstall } from "../../plugins/manifest.js";
import type { PluginOrigin } from "../../plugins/plugin-origin.types.js";
import type { ChannelMeta } from "./types.public.js";
export type ChannelUiMetaEntry = {
    id: string;
    label: string;
    detailLabel: string;
    systemImage?: string;
};
export type ChannelUiCatalog = {
    entries: ChannelUiMetaEntry[];
    order: string[];
    labels: Record<string, string>;
    detailLabels: Record<string, string>;
    systemImages: Record<string, string>;
    byId: Record<string, ChannelUiMetaEntry>;
};
export type ChannelPluginCatalogEntry = {
    id: string;
    pluginId?: string;
    origin?: PluginOrigin;
    meta: ChannelMeta;
    install: PluginPackageInstall & {
        npmSpec: string;
    };
    installSource?: PluginInstallSourceInfo;
};
type CatalogOptions = {
    workspaceDir?: string;
    catalogPaths?: string[];
    officialCatalogPaths?: string[];
    env?: NodeJS.ProcessEnv;
    excludeWorkspace?: boolean;
};
export declare function buildChannelUiCatalog(plugins: Array<{
    id: string;
    meta: ChannelMeta;
}>): ChannelUiCatalog;
export declare function listChannelPluginCatalogEntries(options?: CatalogOptions): ChannelPluginCatalogEntry[];
export declare function getChannelPluginCatalogEntry(id: string, options?: CatalogOptions): ChannelPluginCatalogEntry | undefined;
export {};
