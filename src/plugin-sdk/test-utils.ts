// Narrow plugin-sdk surface for the bundled test-utils plugin.
// Keep this list additive and scoped to symbols used under extensions/test-utils.

export { removeAckReactionAfterReply, shouldAckReaction } from "../channels/ack-reactions.js";
export type { ChannelAccountSnapshot, ChannelGatewayContext } from "../channels/plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { RuntimeEnv } from "../runtime.js";
export type { MockFn } from "../test-utils/vitest-mock-fn.js";
