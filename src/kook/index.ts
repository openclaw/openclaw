// KOOK Channel Core Implementation
// Re-exports for plugin runtime

export { monitorKookProvider } from "./monitor/provider.js";
export type { MonitorKookOpts } from "./monitor/provider.js";

export { sendMessageKook, sendDirectMessageKook } from "./send.js";
export type { KookSendOpts, KookSendResult } from "./send.js";

export { resolveKookAccount, listKookAccountIds } from "./accounts.js";
export type { ResolvedKookAccount } from "./accounts.js";

export { resolveKookToken, normalizeKookToken } from "./token.js";

export { probeKook } from "./probe.js";

export { KOOK_API_BASE, KOOK_API_VERSION, fetchKook, getKookGateway } from "./api.js";
