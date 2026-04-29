// Compatibility facade for legacy npm-installed Feishu plugin packages.
// Keep this surface scoped to the historical Feishu package imports.

import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DmPolicy, GroupToolPolicyConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
export type { ReplyPayload } from "./reply-payload.js";
export { logTypingFailure } from "../channels/logging.js";
export type { AllowlistMatch } from "../channels/allowlist-match.js";
export {
  buildSingleChannelSecretPromptState,
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptSingleChannelSecretInput,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  splitSetupEntries as splitOnboardingEntries,
} from "../channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export type {
  BaseProbeResult,
  ChannelGroupContext,
  ChannelMeta,
} from "../channels/plugins/types.public.js";
export type { ChannelOutboundAdapter } from "../channels/plugins/types.adapters.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixContext } from "../channels/reply-prefix.js";
export { createTypingCallbacks } from "../channels/typing.js";
export type { OpenClawConfig as ClawdbotConfig, OpenClawConfig } from "../config/config.js";
export {
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

export type ChannelOnboardingDmPolicy = {
  label: string;
  channel: ChannelId;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: OpenClawConfig) => DmPolicy;
  setPolicy: (cfg: OpenClawConfig, policy: DmPolicy) => OpenClawConfig;
  promptAllowFrom?: (params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    accountId?: string;
  }) => Promise<OpenClawConfig>;
};

export type ChannelOnboardingAdapter = {
  channel: ChannelId;
  getStatus: (ctx: {
    cfg: OpenClawConfig;
    options?: unknown;
    accountOverrides: Partial<Record<ChannelId, string>>;
  }) => Promise<{
    channel: ChannelId;
    configured: boolean;
    statusLines: string[];
    selectionHint?: string;
    quickstartScore?: number;
  }>;
  configure: (ctx: {
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    prompter: WizardPrompter;
    options?: unknown;
    accountOverrides: Partial<Record<ChannelId, string>>;
    shouldPromptAccountIds: boolean;
    forceAllowFrom: boolean;
  }) => Promise<{ cfg: OpenClawConfig; accountId?: string }>;
  dmPolicy?: ChannelOnboardingDmPolicy;
};
