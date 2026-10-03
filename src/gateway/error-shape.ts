import { errorShape } from "../../packages/gateway-protocol/src/index.js";
import { copyErrorDiagnostic } from "../infra/error-diagnostics.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseAdmissionErrorShape,
} from "../state/agent-database-admission.js";

/** Preserve typed refusals while allowing each surface's existing error message. */
export function errorShapeFromError(
  code: Parameters<typeof errorShape>[0],
  error: unknown,
  opts?: Parameters<typeof errorShape>[2] & { message?: string },
) {
  const { message, ...metadata } = opts ?? {};
  const shape =
    error instanceof AgentDatabaseAdmissionError
      ? createAgentDatabaseAdmissionErrorShape(error.refusal)
      : errorShape(code, message ?? formatErrorMessageWithCode(error), metadata);
  copyErrorDiagnostic(error, shape);
  return shape;
}
