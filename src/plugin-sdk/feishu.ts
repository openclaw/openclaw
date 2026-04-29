/**
 * Compatibility facade for the `openclaw/plugin-sdk/feishu` subpath.
 *
 * Restores the export surface consumed by `@openclaw/feishu@2026.3.13`
 * (and earlier) which was removed in 1e3ce10e2.  Without this shim the
 * published npm extension crashes at runtime with:
 *
 *   TypeError: (0 , _feishu.createScopedPairingAccess) is not a function
 *
 * Fixes #74138
 *
 * @deprecated New channel plugins should import from the generic
 *   channel SDK subpaths (e.g. `openclaw/plugin-sdk/channel-pairing`).
 */

// ── auto-reply / history ─────────────────────────────────────────────
export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";

// ── reply payload ────────────────────────────────────────────────────
export type { ReplyPayload } from "./reply-payload.js";

// ── channels / logging ───────────────────────────────────────────────
export { logTypingFailure } from "../channels/logging.js";

// ── channels / plugins ───────────────────────────────────────────────
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  buildSingleChannelSecretPromptState,
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptSingleChannelSecretInput,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  splitSetupEntries,
  splitSetupEntries as splitOnboardingEntries,
} from "../channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export type {
  BaseProbeResult,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelMeta,
  ChannelOutboundAdapter,
} from "../channels/plugins/types.public.js";
export type {
  ChannelConfiguredBindingProvider,
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingMatch,
} from "../channels/plugins/types.adapters.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";

// ── channels / reply ─────────────────────────────────────────────────
export { createReplyPrefixContext } from "../channels/reply-prefix.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";

// ── channels / typing ────────────────────────────────────────────────
export { createTypingCallbacks } from "../channels/typing.js";

// ── config ───────────────────────────────────────────────────────────
export type { OpenClawConfig as ClawdbotConfig, OpenClawConfig } from "../config/types.js";
export { resolveChannelContextVisibilityMode } from "../config/context-visibility.js";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type { DmPolicy, GroupToolPolicyConfig } from "../config/types.js";

// ── security ─────────────────────────────────────────────────────────
export {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
  type ContextVisibilityKind,
} from "../security/context-visibility.js";

// ── secret-input ─────────────────────────────────────────────────────
export type { SecretInput } from "./secret-input.js";
export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";

// ── infra ────────────────────────────────────────────────────────────
export { createDedupeCache } from "../infra/dedupe.js";
export { installRequestBodyLimitGuard, readJsonBodyWithLimit } from "../infra/http-body.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
export type { OutboundIdentity } from "../infra/outbound/identity.js";

// ── plugins ──────────────────────────────────────────────────────────
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { AnyAgentTool, OpenClawPluginApi } from "../plugins/types.js";

// ── routing ──────────────────────────────────────────────────────────
export { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "../routing/session-key.js";

// ── runtime / terminal ───────────────────────────────────────────────
export type { RuntimeEnv } from "../runtime.js";
export { formatDocsLink } from "../terminal/links.js";

// ── plugin-sdk helpers ───────────────────────────────────────────────
export { evaluateSenderGroupAccessForPolicy } from "./group-access.js";
export { createActionGate } from "../agents/tools/common.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { createClackPrompter } from "../wizard/clack-prompter.js";
export { feishuSetupWizard, feishuSetupAdapter } from "./feishu-setup.js";
export { buildAgentMediaPayload } from "./agent-media-payload.js";
export { readJsonFileWithFallback } from "./json-store.js";
export { createChannelPairingController } from "./channel-pairing.js";
export { createPersistentDedupe } from "./persistent-dedupe.js";
export {
  buildBaseChannelStatusSummary,
  buildProbeChannelStatusSummary,
  buildRuntimeAccountStatusSnapshot,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
export { withTempDownloadPath } from "./temp-path.js";

// ── feishu-conversation helpers ──────────────────────────────────────
export {
  buildFeishuConversationId,
  createFeishuThreadBindingManager,
  parseFeishuDirectConversationId,
  parseFeishuConversationId,
  parseFeishuTargetId,
} from "./feishu-conversation.js";

// ── webhook ingress ──────────────────────────────────────────────────
export {
  createWebhookAnomalyTracker,
  createFixedWindowRateLimiter,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  applyBasicWebhookRequestGuards,
} from "./webhook-ingress.js";

// ── pairing (new exports required by @openclaw/feishu@2026.3.13) ─────
export { createScopedPairingAccess } from "./pairing-access.js";
export { issuePairingChallenge } from "../pairing/pairing-challenge.js";

// ── onboarding type aliases (renamed since 2026.3.x) ────────────────
export type { ChannelSetupAdapter as ChannelOnboardingAdapter } from "../channels/plugins/types.adapters.js";
export type { ChannelSetupDmPolicy as ChannelOnboardingDmPolicy } from "../channels/plugins/setup-wizard-types.js";
