// Narrow plugin-sdk surface for the bundled lanxin plugin.
// Keep this list additive and scoped to symbols used under extensions/lanxin.

export type {
  BaseProbeResult,
  ChannelGroupContext,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.js";
export type { ChannelOnboardingAdapter } from "../channels/plugins/onboarding-types.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  buildBaseChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
export type { OpenClawConfig } from "../config/config.js";
/** @deprecated Use OpenClawConfig instead */
export type { OpenClawConfig as ClawdbotConfig } from "../config/config.js";
export type { GroupToolPolicyConfig } from "../config/types.js";
export { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithCommandGate,
} from "../security/dm-policy-shared.js";
export { logInboundDrop } from "../channels/logging.js";
export { buildAgentMediaPayload } from "./agent-media-payload.js";
export {
  createNormalizedOutboundDeliverer,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
} from "./reply-payload.js";
export type { OutboundReplyPayload } from "./reply-payload.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export { createPersistentDedupe } from "./persistent-dedupe.js";
export { loadOutboundMediaFromUrl } from "./outbound-media.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { formatDocsLink } from "../terminal/links.js";
export type { RuntimeEnv } from "../runtime.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
