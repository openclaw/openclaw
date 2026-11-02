/** Shared guest protocol for Code Mode executor plugins. Host tool authority remains in core. */
export {
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
} from "../agents/code-mode-errors.js";
export type {
  CodeModeExecutor,
  CodeModeExecutorContinuation,
  CodeModeExecutorId,
  CodeModeExecutorInlineHost,
  CodeModeExecutorResumeInput,
  CodeModeExecutorRunOptions,
  CodeModeExecutorStartInput,
  CodeModeFailureCode,
  CodeModeWorkerResult,
} from "../agents/code-mode-executor-types.js";
export { CODE_MODE_CONTROLLER_SOURCE } from "../agents/code-mode-controller-source.js";
export {
  boundCodeModeError,
  captureCodeModeOutput,
  captureCodeModeValue,
  EMPTY_CODE_MODE_OUTPUT,
} from "../agents/code-mode-json.js";
export type { CodeModeOutputSource } from "../agents/code-mode-json.js";
export type { CodeModeApiVirtualFile } from "../agents/code-mode-namespaces.js";
export {
  buildUserSource,
  normalizeSourceStack,
  SOURCE_LOCATION_KEY,
  USER_SOURCE_FILE,
} from "../agents/code-mode-source-location.js";
export type { SourceLocation } from "../agents/code-mode-source-location.js";
export { prepareSource } from "../agents/code-mode-source.js";
export { CODE_MODE_WORKER_WATCHDOG_GRACE_MS } from "../agents/code-mode-worker-types.js";
export type {
  CodeModeConfig,
  CodeModeNamespaceDescriptor,
  CodeModeVmResult,
  CodeModeWorkerBoundary,
  CodeModeWorkerContinuation,
  CodeModeWorkerPayload,
  CodeModeWorkerThreadResult,
  PendingBridgeRequest,
  SettledBridgeRequest,
} from "../agents/code-mode-worker-types.js";
export { ToolInputError } from "../agents/tool-input-error.js";
