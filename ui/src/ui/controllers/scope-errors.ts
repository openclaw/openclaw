import { ConnectErrorDetailCodes } from "../../../../src/gateway/protocol/connect-error-details.js";
import { GatewayRequestError, resolveGatewayErrorDetailCode } from "../gateway.ts";

export function isMissingOperatorReadScopeError(err: unknown): boolean {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  const detailCode = resolveGatewayErrorDetailCode(err);
  if (detailCode === ConnectErrorDetailCodes.AUTH_UNAUTHORIZED) {
    return true;
  }
  return false;
}

export function formatMissingOperatorReadScopeMessage(feature: string): string {
  return `This connection is missing operator.read, so ${feature} cannot be loaded yet.`;
}
