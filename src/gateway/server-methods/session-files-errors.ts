import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";

export function sessionFilesError(
  type: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}
