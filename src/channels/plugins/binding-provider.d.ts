import type { ChannelConfiguredBindingProvider } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";
export declare function resolveChannelConfiguredBindingProvider(plugin: Pick<ChannelPlugin, "bindings"> | {
    bindings?: ChannelConfiguredBindingProvider;
} | null | undefined): ChannelConfiguredBindingProvider | undefined;
export declare function resolveChannelConfiguredBindingProviderByChannel(channel: string): ChannelConfiguredBindingProvider | undefined;
