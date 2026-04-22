// Shared error graph/format helpers without the full infra-runtime surface.

export const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE = "OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE";
export const SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE =
  "Plugin runtime subagent methods are only available during a gateway request.";
export const OPENCLAW_INTERSESSION_SESSION_NOT_FOUND =
  "OPENCLAW_INTERSESSION_SESSION_NOT_FOUND";
export const OPENCLAW_INTERSESSION_SEND_DENIED = "OPENCLAW_INTERSESSION_SEND_DENIED";
export const OPENCLAW_INTERSESSION_UNAVAILABLE = "OPENCLAW_INTERSESSION_UNAVAILABLE";
export const OPENCLAW_INTERSESSION_SEND_FAILED = "OPENCLAW_INTERSESSION_SEND_FAILED";
export const INTERSESSION_RUNTIME_UNAVAILABLE_ERROR_MESSAGE =
  "Plugin runtime interSession.send is only available when the plugin runtime is bound to the gateway transport surface.";

export class RequestScopedSubagentRuntimeError extends Error {
  code = SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE;

  constructor(message = SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_MESSAGE) {
    super(message);
    this.name = "RequestScopedSubagentRuntimeError";
  }
}

export class InterSessionRuntimeUnavailableError extends Error {
  code = OPENCLAW_INTERSESSION_UNAVAILABLE;

  constructor(message = INTERSESSION_RUNTIME_UNAVAILABLE_ERROR_MESSAGE) {
    super(message);
    this.name = "InterSessionRuntimeUnavailableError";
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
