// Narrow plugin-sdk surface for the bundled inboxapi plugin.
// Keep this list additive and scoped to symbols used under extensions/inboxapi.

export { setAccountEnabledInConfigSection } from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
