export type { ChannelMessageActionAdapter } from "../channels/plugins/types.js";
export type { SignalAccountConfig } from "../config/types.js";
export * from "./channel-plugin-common.js";

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
