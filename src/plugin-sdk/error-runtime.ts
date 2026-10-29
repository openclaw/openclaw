// Shared error graph/format helpers without the full infra-runtime surface.

/** Stable error code for subagent APIs called outside an authenticated gateway request. */
export const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE = "OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE";
/** Default message paired with `SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE`. */
export const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE =
  "Plugin runtime subagent methods are only available during a gateway request.";

/** Error thrown when request-scoped plugin runtime APIs are used outside their scope. */
export class RequestScopedSubagentRuntimeError extends Error {
  code = SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE;

  constructor(message = SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE) {
    super(message);
    this.name = "RequestScopedSubagentRuntimeError";
  }
}

export {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  formatUncaughtError,
  readErrorName,
  toErrorObject,
} from "../infra/errors.js";
export { attachErrorDiagnostic, formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
export { materializeErrorStack } from "../infra/error-graph-internal.js";
export {
  coerceErrorMessage,
  toStringifiedError,
} from "../../packages/normalization-core/src/error-coercion.js";
// Policy-free structural formatting for log-bound warnings: logs are written raw
// and masked only at the egress sinks, so warning text must keep the full cause
// chain without applying a redaction policy here.
export { formatErrorMessage as formatErrorMessageRaw } from "../../packages/normalization-core/src/error-coercion.js";
export { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
export { isApprovalNotFoundError } from "../infra/approval-errors.ts";
