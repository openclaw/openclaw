export type { ChannelMessageActionAdapter } from "../channels/plugins/types.js";
export type { ResolvedSignalAccount } from "../../extensions/signal/src/accounts.js";
export type { SignalAccountConfig } from "../config/types.js";
export * from "./channel-plugin-common.js";
export {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../../extensions/signal/src/accounts.js";
export {
  looksLikeSignalTargetId,
  normalizeSignalMessagingTarget,
} from "../channels/plugins/normalize/signal.js";

export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
export { signalOnboardingAdapter } from "../../extensions/signal/src/onboarding.js";
export { SignalConfigSchema } from "../config/zod-schema.providers-core.js";

export { normalizeE164 } from "../utils.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";

export {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
