import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import type { ChannelId } from "./channel-id.types.js";
type ChannelRegistryValueResolver<TValue> = (entry: PluginChannelRegistration) => TValue | undefined;
export declare function createChannelRegistryLoader<TValue>(resolveValue: ChannelRegistryValueResolver<TValue>): (id: ChannelId) => Promise<TValue | undefined>;
export {};
