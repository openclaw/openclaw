export type { ChannelMessageActionAdapter } from "../channels/plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { SignalAccountConfig } from "../config/types.js";
export type { ResolvedSignalAccount } from "../../extensions/signal/src/accounts.js";
export type {
  ChannelMessageActionContext,
  ChannelPlugin,
  OpenClawPluginApi,
  PluginRuntime,
} from "./channel-plugin-common.js";
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
  looksLikeSignalTargetId,
  normalizeSignalMessagingTarget,
} from "../channels/plugins/normalize/signal.js";

export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
export { SignalConfigSchema } from "../config/zod-schema.providers-core.js";

export { normalizeE164 } from "../utils.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";

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
  resolveSignalAccount,
} from "../../extensions/signal/src/accounts.js";
export { resolveSignalReactionLevel } from "../../extensions/signal/src/reaction-level.js";
export {
  removeReactionSignal,
  sendReactionSignal,
} from "../../extensions/signal/src/send-reactions.js";
export { sendMessageSignal } from "../../extensions/signal/src/send.js";
