import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
  type SessionTranscriptOwnerMismatchErrorDetails,
} from "../../packages/gateway-protocol/src/index.js";
import { SessionTranscriptOwnerMismatchError } from "../config/sessions/session-transcript-owner-error.js";
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
  const ended = collectNestedErrorCandidates(error).find(
    (candidate) => candidate instanceof IncognitoSessionEndedError,
  );
  const shape =
    error instanceof AgentDatabaseAdmissionError
      ? createAgentDatabaseAdmissionErrorShape(error.refusal)
      : ended instanceof IncognitoSessionEndedError
        ? errorShape(ErrorCodes.UNAVAILABLE, ended.message, {
            ...metadata,
            retryable: false,
            details: { code: ended.code },
          })
        : error instanceof SessionTranscriptOwnerMismatchError
          ? errorShape(ErrorCodes.UNAVAILABLE, error.message, {
              ...metadata,
              retryable: false,
              details: {
                code: GatewayErrorDetailCodes.SESSION_TRANSCRIPT_OWNER_MISMATCH,
                sessionId: error.sessionId,
                ownerSessionKey: error.ownerSessionKey,
                requestedSessionKey: error.requestedSessionKey,
              } satisfies SessionTranscriptOwnerMismatchErrorDetails,
            })
          : errorShape(code, message ?? formatErrorMessageWithCode(error), metadata);
  copyErrorDiagnostic(error, shape);
  return shape;
}
