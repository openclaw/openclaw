// Narrow plugin-sdk surface for the bundled gohighlevel plugin.
// Keep this list additive and scoped to symbols used under extensions/gohighlevel.

export type { ChannelDock } from "../channels/dock.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../channels/plugins/onboarding-types.js";
export {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptAccountId,
} from "../channels/plugins/onboarding/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export type { ChannelStatusIssue } from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export type { OpenClawConfig } from "../config/config.js";
export type { DmPolicy } from "../config/types.js";
export {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  requireOpenAllowFrom,
} from "../config/zod-schema.core.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
export { missingTargetError } from "../infra/outbound/target-errors.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export { formatDocsLink } from "../terminal/links.js";
export { resolveWebhookPath } from "./webhook-path.js";
export {
  registerWebhookTargetWithPluginRoute,
  rejectNonPostWebhookRequest,
  resolveWebhookTargets,
} from "./webhook-targets.js";
export type { WizardPrompter } from "../wizard/prompts.js";
