// Private bridge for bundled channel plugins. Keep public sdk/core slim for
// third-party plugins; bundled channels can reach shared runtime helpers here.
export type {
  ChannelMessageActionContext,
  OpenClawPluginApi,
  PluginRuntime,
} from "../plugin-sdk/channel-plugin-common.js";
export { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
export {
  buildAgentSessionKey,
  type RoutePeer,
  type RoutePeerKind,
} from "../routing/resolve-route.js";
export { resolveThreadSessionKeys } from "../routing/session-key.js";
