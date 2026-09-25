import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
} from "../../packages/gateway-protocol/src/index.js";

export function invalidSessionRequest(
  message: string,
  options?: Parameters<typeof errorShape>[2],
): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, message, options) };
}
