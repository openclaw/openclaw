import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ProjectCheckoutError } from "../../projects/project-registry.js";
export function projectCheckoutError(error: unknown) {
  return errorShape(
    error instanceof ProjectCheckoutError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
    formatErrorMessage(error),
  );
}
