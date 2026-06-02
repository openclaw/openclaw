/** Stable machine-readable code for subagent runtime calls made outside request scope. */
export const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE = "OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE";
/** Default message shown when a plugin asks for request-scoped subagent APIs too early. */
export const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE =
  "Plugin runtime subagent methods are only available during a gateway request.";

/** Error type used by SDK runtime guards when a request-owned helper is unavailable. */
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
} from "../infra/errors.js";
export { isApprovalNotFoundError } from "../infra/approval-errors.ts";
