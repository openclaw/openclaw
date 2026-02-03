// X channel public exports

// Service layer - high-level API for cross-channel use
export {
  createXService,
  tryCreateXService,
  type XService,
  type XServiceOptions,
} from "./service.js";

// Low-level client management
export { XClientManager, getOrCreateClientManager, removeClientManager } from "./client.js";

// Account configuration
export {
  listXAccountIds,
  resolveXAccount,
  isXAccountConfigured,
  resolveDefaultXAccountId,
  DEFAULT_ACCOUNT_ID,
} from "./accounts.js";

// Channel operations
export { probeX, type XProbeResult } from "./probe.js";
export { sendMessageX, chunkTextForX, X_CHAR_LIMIT } from "./send.js";
export { loadXPollState, saveXPollState, updateXLastTweetId } from "./state.js";
export {
  monitorXProvider,
  type XMonitorOptions,
  type XMonitorResult,
  type XMonitorDeps,
} from "./monitor.js";

// Types
export type {
  XAccountConfig,
  XMention,
  XSendResult,
  XPollState,
  XLogSink,
  XFollowResult,
  XDmResult,
  XLikeResult,
  XUserInfo,
} from "./types.js";
