// Narrow plugin-sdk surface for the bundled zalo plugin.
// Keep this list additive and scoped to symbols used under extensions/zalo.

export { jsonResult, readStringParam } from "../agents/tools/common.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export type { ChannelDock } from "../channels/dock.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { listDirectoryUserEntriesFromAllowFrom } from "../channels/plugins/directory-config-helpers.js";
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
  promptSingleChannelSecretInput,
  resolveAccountIdForConfigure,
} from "../channels/plugins/onboarding/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export type { OpenClawConfig } from "../config/config.js";
export {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type { GroupPolicy, MarkdownTableMode } from "../config/types.js";
export type { SecretInput } from "../config/types.secrets.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
export { buildSecretInputSchema } from "./secret-input-schema.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export { createDedupeCache } from "../infra/dedupe.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { formatAllowFromLowercase, isNormalizedSenderAllowed } from "./allow-from.js";
export {
  resolveDirectDmAuthorizationOutcome,
  resolveSenderCommandAuthorizationWithRuntime,
} from "./command-auth.js";
export { resolveChannelAccountConfigBasePath } from "./config-paths.js";
export { evaluateSenderGroupAccess } from "./group-access.js";
export type { SenderGroupAccessDecision } from "./group-access.js";
export { resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export { issuePairingChallenge } from "../pairing/pairing-challenge.js";
export { buildChannelSendResult } from "./channel-send-result.js";
export type { OutboundReplyPayload } from "./reply-payload.js";
export {
  isNumericTargetId,
  resolveOutboundMediaUrls,
  sendMediaWithLeadingCaption,
  sendPayloadWithChunkedTextAndMedia,
} from "./reply-payload.js";
export {
  buildBaseAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
} from "./status-helpers.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export { extractToolSend } from "./tool-send.js";
export {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "./webhook-memory-guards.js";
export { resolveWebhookPath } from "./webhook-path.js";
export {
  applyBasicWebhookRequestGuards,
  readJsonWebhookBodyOrReject,
} from "./webhook-request-guards.js";
export type {
  RegisterWebhookPluginRouteOptions,
  RegisterWebhookTargetOptions,
} from "./webhook-targets.js";
export {
  registerWebhookTarget,
  registerWebhookTargetWithPluginRoute,
  resolveSingleWebhookTarget,
  resolveWebhookTargets,
} from "./webhook-targets.js";
