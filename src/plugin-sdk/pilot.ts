// Narrow plugin-sdk surface for the bundled pilot plugin.
// Keep this list additive and scoped to symbols used under extensions/pilot.

export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export {
  buildAccountScopedDmSecurityPolicy,
  formatPairingApproveHint,
} from "../channels/plugins/helpers.js";
export { readStoreAllowFromForDmPolicy } from "../security/dm-policy-shared.js";
export type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../channels/plugins/onboarding-types.js";
export {
  resolveAccountIdForConfigure,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../channels/plugins/onboarding/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export { patchScopedAccountConfig } from "../channels/plugins/setup-helpers.js";
export type { BaseProbeResult } from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type { OpenClawConfig } from "../config/config.js";
export type { DmPolicy, MarkdownConfig } from "../config/types.js";
export {
  DmPolicySchema,
  MarkdownConfigSchema,
  requireOpenAllowFrom,
} from "../config/zod-schema.core.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export { createAccountStatusSink, runPassiveAccountLifecycle } from "./channel-lifecycle.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export { issuePairingChallenge } from "../pairing/pairing-challenge.js";
export { dispatchInboundReplyWithBase } from "./inbound-reply-dispatch.js";
export type { OutboundReplyPayload } from "./reply-payload.js";
export { formatTextWithAttachmentLinks, resolveOutboundMediaUrls } from "./reply-payload.js";
export { createLoggerBackedRuntime } from "./runtime.js";
export { buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary } from "./status-helpers.js";
export {
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
export { mapAllowFromEntries } from "./channel-config-helpers.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";
