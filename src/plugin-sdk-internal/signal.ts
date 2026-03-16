export type { ChannelMessageActionAdapter } from "../channels/plugins/types.js";
export type { ResolvedSignalAccount } from "../../extensions/signal/src/accounts.js";
export type { SignalAccountConfig } from "../config/types.js";
export * from "../plugin-sdk/channel-plugin-common.js";
export {
  listEnabledSignalAccounts,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../../extensions/signal/src/accounts.js";
export { resolveSignalReactionLevel } from "../../extensions/signal/src/reaction-level.js";
export {
  removeReactionSignal,
  sendReactionSignal,
} from "../../extensions/signal/src/send-reactions.js";
export { sendMessageSignal } from "../../extensions/signal/src/send.js";
export {
  looksLikeSignalTargetId,
  normalizeSignalMessagingTarget,
} from "../channels/plugins/normalize/signal.js";

export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
export { signalSetupWizard } from "../../extensions/signal/src/setup-surface.js";
export { signalSetupAdapter } from "../../extensions/signal/src/setup-core.js";
export { SignalConfigSchema } from "../config/zod-schema.providers-core.js";

export { normalizeE164 } from "../utils.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";

export {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "../plugin-sdk/status-helpers.js";
