import { isGatewayCredentialsRequiredError } from "./call.js";
import { isGatewayTransportError } from "./transport-error.js";

/** Pre-dispatch failures permit local fallback only for the selected local backend. */
export function resolveGatewayMutationFallback(params: {
  error: unknown;
  localTarget: boolean;
}): "unreachable" | "credentials-required" | "non-local" | undefined {
  const { error, localTarget } = params;
  const reason =
    isGatewayTransportError(error) && error.kind === "closed" && error.code === undefined
      ? "unreachable"
      : isGatewayCredentialsRequiredError(error)
        ? "credentials-required"
        : undefined;
  // Missing credentials prove no dispatch, but a live local scheduler may still own its store.
  return reason && !localTarget ? "non-local" : reason;
}
