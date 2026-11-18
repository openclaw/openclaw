import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";

export class GatewayOperatorAccessUnavailableError extends Error {
  constructor() {
    super("Gateway access policy is unavailable; retry after its plugin is ready.");
    this.name = "GatewayOperatorAccessUnavailableError";
  }
}

/** Temporary policy loading failures must not revoke retained execution authority. */
export function isGatewayOperatorAccessUnavailable(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) => candidate instanceof GatewayOperatorAccessUnavailableError,
  );
}
