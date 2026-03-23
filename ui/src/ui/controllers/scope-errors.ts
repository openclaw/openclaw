import { GatewayRequestError } from "../gateway.ts";

export function isMissingOperatorReadScopeError(err: unknown): boolean {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  return (err.message || "").includes("missing scope: operator.read");
}

export function formatMissingOperatorReadScopeMessage(feature: string): string {
  return `This connection is missing operator.read, so ${feature} cannot be loaded yet.`;
}
