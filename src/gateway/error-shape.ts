import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { renderStorageFailureSummary } from "../agents/failover/assistant-request-failure-copy.js";
import { copyErrorDiagnostic } from "../infra/error-diagnostics.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { classifyGatewayStorageFailure } from "../infra/sqlite-error-diagnostics.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
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
  const candidates = collectNestedErrorCandidates(error);
  const ended = candidates.find((candidate) => candidate instanceof IncognitoSessionEndedError);
  const storageMessage = candidates.some(
    (candidate) => classifyGatewayStorageFailure(candidate) === "SQLITE_FULL",
  )
    ? renderStorageFailureSummary("SQLITE_FULL")
    : undefined;
  const shape =
    error instanceof AgentDatabaseAdmissionError
      ? createAgentDatabaseAdmissionErrorShape(error.refusal)
      : ended instanceof IncognitoSessionEndedError
        ? errorShape(ErrorCodes.UNAVAILABLE, ended.message, {
            ...metadata,
            retryable: false,
            details: { code: ended.code },
          })
        : storageMessage
          ? errorShape(ErrorCodes.UNAVAILABLE, storageMessage, {
              ...metadata,
              // A retryable resource failure must not replay an unacknowledged write.
              retryable: !hasSqliteWorkerOutcomeUnknown(error) && metadata.retryable !== false,
              details: { code: "SQLITE_FULL" },
            })
          : errorShape(code, message ?? formatErrorMessageWithCode(error), metadata);
  copyErrorDiagnostic(error, shape);
  return shape;
}
