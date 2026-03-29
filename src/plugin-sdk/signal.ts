// Private helper surface for the bundled signal plugin.
// Keep this list additive and scoped to the bundled Signal surface.

export type { ChannelMessageActionAdapter } from "../channels/plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { SignalAccountConfig } from "../config/types.js";
export type { ResolvedSignalAccount } from "./signal-surface.js";
export type {
  ChannelMessageActionContext,
  ChannelPlugin,
  OpenClawPluginApi,
  PluginRuntime,
} from "./channel-plugin-common.js";
export type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
export type {
  ChannelSetupWizard,
  ChannelSetupWizardTextInput,
} from "../channels/plugins/setup-wizard.js";
export {
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  deleteAccountFromConfigSection,
  emptyPluginConfigSchema,
  formatPairingApproveHint,
  getChatChannelMeta,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
} from "./channel-plugin-common.js";
export {
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
} from "../channels/plugins/setup-helpers.js";
export { formatCliCommand } from "../cli/command-format.js";
export { formatDocsLink } from "../terminal/links.js";

export {
  looksLikeSignalTargetId,
  normalizeSignalMessagingTarget,
} from "../channels/plugins/normalize/signal.js";
export { detectBinary } from "../plugins/setup-binary.js";
export { installSignalCli } from "../plugins/signal-cli-install.js";

export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
export { SignalConfigSchema } from "../config/zod-schema.providers-core.js";

export { normalizeE164 } from "../utils.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export { chunkText } from "../auto-reply/chunk.js";
export {
  createCliPathTextInput,
  createDelegatedTextInputShouldPrompt,
} from "../channels/plugins/setup-wizard-binary.js";
export { createDelegatedSetupWizardProxy } from "../channels/plugins/setup-wizard-proxy.js";
export {
  createTopLevelChannelDmPolicy,
  parseSetupEntriesAllowingWildcard,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  setSetupChannelEnabled,
} from "../channels/plugins/setup-wizard-helpers.js";

export {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";

export {
  listEnabledSignalAccounts,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
} from "./signal-surface.js";
export { isSignalSenderAllowed } from "./signal-surface.js";
export type { SignalSender } from "./signal-surface.js";
export { monitorSignalProvider } from "./signal-surface.js";
export { probeSignal } from "./signal-surface.js";
export { resolveSignalReactionLevel } from "./signal-surface.js";
export { removeReactionSignal, sendReactionSignal } from "./signal-surface.js";
export { sendMessageSignal } from "./signal-surface.js";
export { signalMessageActions } from "./signal-surface.js";
export { resolveAckReaction } from "../agents/identity.js";
export { shouldAckReaction } from "../channels/ack-reactions.js";
