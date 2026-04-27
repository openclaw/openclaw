import type { ActiveChannelPluginRuntimeShape } from "../../plugins/channel-registry-state.types.js";
export type LoadedChannelPlugin = ActiveChannelPluginRuntimeShape & {
    id: string;
    meta: NonNullable<ActiveChannelPluginRuntimeShape["meta"]>;
};
export declare function listLoadedChannelPlugins(): LoadedChannelPlugin[];
export declare function getLoadedChannelPluginById(id: string): LoadedChannelPlugin | undefined;
