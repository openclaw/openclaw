// Narrow plugin-sdk surface for the bundled matrix plugin.
// Keep this list additive and scoped to symbols used under extensions/matrix.

export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../agents/tools/common.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export {
  compileAllowlist,
  resolveCompiledAllowlistMatch,
  resolveAllowlistCandidates,
  resolveAllowlistMatchByCandidates,
} from "../channels/allowlist-match.js";
export { mergeAllowlist, summarizeMapping } from "../channels/allowlists/resolve-utils.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export type { NormalizedLocation } from "../channels/location.js";
export { formatLocationText, toLocationContext } from "../channels/location.js";
export { logInboundDrop, logTypingFailure } from "../channels/logging.js";
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export { formatAllowlistMatchMeta } from "../channels/plugins/allowlist-match.js";
export {
  buildChannelKeyCandidates,
  resolveChannelEntryMatch,
} from "../channels/plugins/channel-config.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export {
  buildSingleChannelSecretPromptState,
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptSingleChannelSecretInput,
  setTopLevelChannelGroupPolicy,
} from "../channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export { applyAccountNameToChannelSection } from "../channels/plugins/setup-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export type {
  BaseProbeResult,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelOutboundAdapter,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelToolSend,
} from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export { createTypingCallbacks } from "../channels/typing.js";
export type { OpenClawConfig } from "../config/config.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type {
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyConfig,
  MarkdownTableMode,
} from "../config/types.js";
export type { SecretInput } from "../config/types.secrets.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
export { buildSecretInputSchema } from "./secret-input-schema.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { issuePairingChallenge } from "../pairing/pairing-challenge.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export type { PollInput } from "../polls.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "../security/dm-policy-shared.js";
export { formatDocsLink } from "../terminal/links.js";
export { normalizeStringEntries } from "../shared/string-normalization.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export { formatResolvedUnresolvedNote } from "./resolution-notes.js";
export { runPluginCommandWithTimeout } from "./run-command.js";
export { dispatchReplyFromConfigWithSettledDispatcher } from "./inbound-reply-dispatch.js";
export { createLoggerBackedRuntime, resolveRuntimeEnv } from "./runtime.js";
export { resolveInboundSessionEnvelopeContext } from "../channels/session-envelope.js";
export {
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
} from "./status-helpers.js";
export { matrixSetupWizard } from "../../extensions/matrix/src/setup-surface.js";
export { matrixSetupAdapter } from "../../extensions/matrix/src/setup-core.js";
