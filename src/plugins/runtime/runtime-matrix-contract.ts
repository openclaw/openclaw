// Narrow plugin-sdk surface for the bundled Matrix plugin.
// Keep this list additive and scoped to the runtime contract only.

import { createOptionalChannelSetupSurface } from "../../plugin-sdk/channel-setup.js";

export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
} from "../../agents/tools/common.js";
export type { ReplyPayload } from "../../auto-reply/types.js";
export { resolveAckReaction } from "../../agents/identity.js";
export {
  compileAllowlist,
  resolveCompiledAllowlistMatch,
  resolveAllowlistCandidates,
  resolveAllowlistMatchByCandidates,
} from "../../channels/allowlist-match.js";
export {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "../../channels/allowlists/resolve-utils.js";
export { ensureConfiguredAcpBindingReady } from "../../acp/persistent-bindings.lifecycle.js";
export { resolveConfiguredAcpBindingRecord } from "../../acp/persistent-bindings.resolve.js";
export { resolveControlCommandGate } from "../../channels/command-gating.js";
export type { NormalizedLocation } from "../../channels/location.js";
export { formatLocationText, toLocationContext } from "../../channels/location.js";
export { logInboundDrop, logTypingFailure } from "../../channels/logging.js";
export type { AllowlistMatch } from "../../channels/plugins/allowlist-match.js";
export { formatAllowlistMatchMeta } from "../../channels/plugins/allowlist-match.js";
export {
  buildChannelKeyCandidates,
  resolveChannelEntryMatch,
} from "../../channels/plugins/channel-config.js";
export { createAccountListHelpers } from "../../channels/plugins/account-helpers.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../../channels/plugins/helpers.js";
export {
  buildSingleChannelSecretPromptState,
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptAccountId,
  promptSingleChannelSecretInput,
  setTopLevelChannelGroupPolicy,
} from "../../channels/plugins/setup-wizard-helpers.js";
export { promptChannelAccessConfig } from "../../channels/plugins/setup-group-access.js";
export { PAIRING_APPROVED_MESSAGE } from "../../channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  moveSingleAccountChannelSectionToDefaultAccount,
} from "../../channels/plugins/setup-helpers.js";
export type {
  BaseProbeResult,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
  ChannelOutboundAdapter,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelSetupInput,
  ChannelToolSend,
} from "../../channels/plugins/types.js";
export type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
export { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
export { resolveThreadBindingFarewellText } from "../../channels/thread-bindings-messages.js";
export {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../../channels/thread-bindings-policy.js";
export {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "../../plugin-sdk/matrix.js";
export { createTypingCallbacks } from "../../channels/typing.js";
export { createChannelReplyPipeline } from "../../plugin-sdk/channel-reply-pipeline.js";
export type { OpenClawConfig } from "../../config/config.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../../config/runtime-group-policy.js";
export type {
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyConfig,
  MarkdownTableMode,
} from "../../config/types.js";
export type { SecretInput } from "../../plugin-sdk/secret-input.js";
export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../../plugin-sdk/secret-input.js";
export { ToolPolicySchema } from "../../config/zod-schema.agent-runtime.js";
export { MarkdownConfigSchema } from "../../config/zod-schema.core.js";
export { formatZonedTimestamp } from "../../infra/format-time/format-datetime.js";
export { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
export { maybeCreateMatrixMigrationSnapshot } from "../../infra/matrix-migration-snapshot.js";
export {
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "../../infra/outbound/session-binding-service.js";
export { resolveOutboundSendDep } from "../../infra/outbound/send-deps.js";
export type {
  BindingTargetKind,
  SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
export { isPrivateOrLoopbackHost } from "../../gateway/net.js";
export { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
export { emptyPluginConfigSchema } from "../config-schema.js";
export type { PluginRuntime, RuntimeLogger } from "./types.js";
export type { OpenClawPluginApi } from "../types.js";
export type { PollInput } from "../../polls.js";
export { normalizePollInput } from "../../polls.js";
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
export type { RuntimeEnv } from "../../runtime.js";
export { normalizeStringEntries } from "../../shared/string-normalization.js";
export { formatDocsLink } from "../../terminal/links.js";
export { redactSensitiveText } from "../../logging/redact.js";
export type { WizardPrompter } from "../../wizard/prompts.js";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "../../plugin-sdk/group-access.js";
export { createChannelPairingController } from "../../plugin-sdk/channel-pairing.js";
export { readJsonFileWithFallback, writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";
export { formatResolvedUnresolvedNote } from "../../plugin-sdk/resolution-notes.js";
export { runPluginCommandWithTimeout } from "../../plugin-sdk/run-command.js";
export { createLoggerBackedRuntime, resolveRuntimeEnv } from "../../plugin-sdk/runtime.js";
export { dispatchReplyFromConfigWithSettledDispatcher } from "../../plugin-sdk/inbound-reply-dispatch.js";
export {
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
} from "../../plugin-sdk/status-helpers.js";
export {
  resolveMatrixAccountStorageRoot,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsPath,
  resolveMatrixLegacyFlatStoragePaths,
} from "../../plugin-sdk/matrix.js";
export { getMatrixScopedEnvVarNames } from "../../plugin-sdk/matrix.js";
export {
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../../plugin-sdk/matrix.js";

const matrixSetup = createOptionalChannelSetupSurface({
  channel: "matrix",
  label: "Matrix",
  npmSpec: "@openclaw/matrix",
  docsPath: "/channels/matrix",
});

export const matrixSetupWizard = matrixSetup.setupWizard;
export const matrixSetupAdapter = matrixSetup.setupAdapter;
