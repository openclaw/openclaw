// Narrow plugin-sdk surface for the bundled whatsapp-business plugin.
// Keep this list additive and scoped to symbols used under extensions/whatsapp-business.

export { setAccountEnabledInConfigSection } from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { registerPluginHttpRoute } from "../plugins/http-registry.js";
export type { OpenClawConfig } from "../config/config.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
export { waitUntilAbort } from "./channel-lifecycle.js";
