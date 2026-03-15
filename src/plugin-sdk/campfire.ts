// Narrow plugin-sdk surface for the bundled campfire plugin.
// Keep this list additive and scoped to symbols used under extensions/campfire.

export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type { OpenClawConfig } from "../config/config.js";
export { missingTargetError } from "../infra/outbound/target-errors.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export { resolveWebhookPath } from "./webhook-path.js";
export { registerWebhookTargetWithPluginRoute, resolveWebhookTargets } from "./webhook-targets.js";
export type {
  RegisterWebhookPluginRouteOptions,
  RegisterWebhookTargetOptions,
} from "./webhook-targets.js";
export {
  applyBasicWebhookRequestGuards,
  readJsonWebhookBodyOrReject,
} from "./webhook-request-guards.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export { resolveChannelAccountConfigBasePath } from "./config-paths.js";
export { resolveOutboundMediaUrls } from "./reply-payload.js";
export {
  buildBaseAccountStatusSnapshot,
  buildProbeChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
