import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { QuestionManagerError } from "../question-manager.js";
import type { RespondFn } from "./types.js";

export class QuestionRequestValidationError extends Error {}

export function managerError(error: unknown, respond: RespondFn): boolean {
  if (!(error instanceof QuestionManagerError)) {
    return false;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, error.message, { details: { reason: error.code } }),
  );
  return true;
}
