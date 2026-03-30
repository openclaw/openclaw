// Private helper surface for the bundled signal plugin.
// Keep this list additive and scoped to the bundled Signal surface.

export type { SignalAccountConfig } from "../config/types.js";
export type { ChannelPlugin } from "./channel-plugin-common.js";
export {
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  buildChannelConfigSchema,
  deleteAccountFromConfigSection,
  getChatChannelMeta,
  setAccountEnabledInConfigSection,
} from "./channel-plugin-common.js";
export { SignalConfigSchema } from "../config/zod-schema.providers-core.js";
export {
  looksLikeSignalTargetId,
  normalizeSignalMessagingTarget,
} from "../channels/plugins/normalize/signal.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export { normalizeE164 } from "../utils.js";
export {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
