// Narrow plugin-sdk surface for the bundled feishu plugin.
// Keep this list additive and scoped to symbols used under extensions/feishu.

export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export { logTypingFailure } from "../channels/logging.js";
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { createActionGate } from "../agents/tools/common.js";
export type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../channels/plugins/onboarding-types.js";
export {
  buildSingleChannelSecretPromptState,
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptSingleChannelSecretInput,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  splitOnboardingEntries,
} from "../channels/plugins/onboarding/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export type {
  BaseProbeResult,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelMeta,
  ChannelOutboundAdapter,
} from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixContext } from "../channels/reply-prefix.js";
export { createTypingCallbacks } from "../channels/typing.js";
export type { OpenClawConfig as ClawdbotConfig, OpenClawConfig } from "../config/config.js";
export { resolveChannelGroupToolsPolicy } from "../config/group-policy.js";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type { DmPolicy, GroupToolPolicyConfig } from "../config/types.js";
export type { SecretInput } from "../config/types.secrets.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
export { buildSecretInputSchema } from "./secret-input-schema.js";
export { createDedupeCache } from "../infra/dedupe.js";
export { installRequestBodyLimitGuard, readJsonBodyWithLimit } from "../infra/http-body.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
export type { OutboundIdentity } from "../infra/outbound/identity.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { AnyAgentTool, OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export { formatDocsLink } from "../terminal/links.js";
export { evaluateSenderGroupAccessForPolicy } from "./group-access.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { buildAgentMediaPayload } from "./agent-media-payload.js";
export { readJsonFileWithFallback } from "./json-store.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export { issuePairingChallenge } from "../pairing/pairing-challenge.js";
export { createPersistentDedupe } from "./persistent-dedupe.js";
export {
  buildBaseChannelStatusSummary,
  buildProbeChannelStatusSummary,
  buildRuntimeAccountStatusSnapshot,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
export { withTempDownloadPath } from "./temp-path.js";
export {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "./webhook-memory-guards.js";
export { applyBasicWebhookRequestGuards } from "./webhook-request-guards.js";
