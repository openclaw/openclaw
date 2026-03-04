// Narrow plugin-sdk surface for the bundled dingtalk plugin.
// Keep this list additive and scoped to symbols used under extensions/dingtalk.

export type { ReplyPayload } from "../auto-reply/types.js";
export { logTypingFailure } from "../channels/logging.js";
export type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../channels/plugins/onboarding-types.js";
export {
  addWildcardAllowFrom,
  promptSingleChannelSecretInput,
} from "../channels/plugins/onboarding/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export type {
  BaseProbeResult,
  ChannelMeta,
  ChannelOutboundAdapter,
} from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixContext } from "../channels/reply-prefix.js";
export { createTypingCallbacks } from "../channels/typing.js";
export type { OpenClawConfig as ClawdbotConfig, OpenClawConfig } from "../config/config.js";
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
export { createDedupeCache } from "../infra/dedupe.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { AnyAgentTool, OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export {
  buildBaseChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
