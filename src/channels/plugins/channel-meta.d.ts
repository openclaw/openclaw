import type { PluginPackageChannel } from "../../plugins/manifest.js";
import type { ChannelMeta } from "./types.core.js";
type ArrayFieldMode = "defined" | "non-empty";
type OptionalStringMode = "defined" | "truthy";
export declare function buildManifestChannelMeta(params: {
    id: string;
    channel: PluginPackageChannel;
    label: string;
    selectionLabel: string;
    docsPath: string;
    docsLabel?: string;
    blurb: string;
    detailLabel?: string;
    systemImage?: string;
    arrayFieldMode: ArrayFieldMode;
    selectionDocsPrefixMode: OptionalStringMode;
}): ChannelMeta;
export {};
