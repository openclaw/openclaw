import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { SessionPendingInputConflictError } from "../config/sessions/session-pending-input-custody-error.js";
import { copyErrorDiagnostic } from "../infra/error-diagnostics.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseAdmissionErrorShape,
} from "../state/agent-database-admission.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";

/** Preserve typed refusals while allowing each surface's existing error message. */
export function errorShapeFromError(
  code: Parameters<typeof errorShape>[0],
  error: unknown,
  opts?: Parameters<typeof errorShape>[2] & { message?: string },
) {
  const { message, ...metadata } = opts ?? {};
  const refusal = collectNestedErrorCandidates(error).find(
    (candidate) =>
      candidate instanceof IncognitoSessionEndedError ||
      candidate instanceof SessionPendingInputConflictError,
  );
  const shape =
    error instanceof AgentDatabaseAdmissionError
      ? createAgentDatabaseAdmissionErrorShape(error.refusal)
      : refusal instanceof IncognitoSessionEndedError ||
          refusal instanceof SessionPendingInputConflictError
        ? errorShape(ErrorCodes.UNAVAILABLE, refusal.message, {
            ...metadata,
            retryable: false,
            details: { code: refusal.code },
          })
        : errorShape(code, message ?? formatErrorMessageWithCode(error), metadata);
  copyErrorDiagnostic(error, shape);
  return shape;
}
