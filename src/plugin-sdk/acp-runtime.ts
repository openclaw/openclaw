// Public ACP runtime helpers for plugins that integrate with ACP control/session state.

export { getAcpSessionManager } from "../acp/control-plane/manager.js";
export { AcpRuntimeError, isAcpRuntimeError } from "../acp/runtime/errors.js";
export { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  AcpSessionUpdateTag,
} from "../acp/runtime/types.js";
export { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
export type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
