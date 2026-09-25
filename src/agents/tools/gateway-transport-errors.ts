import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { formatErrorMessage } from "../../infra/errors.js";

export function isStaleGatewayAgentRuntimeIdentityRejection(error: unknown): boolean {
  const message = formatErrorMessage(error);
  if (
    message.includes(
      "gateway rejected required agent runtime identity auth field; refusing to retry without it",
    )
  ) {
    return true;
  }
  return (
    message.includes("invalid connect params") &&
    message.includes("/auth") &&
    message.includes("unexpected property 'agentRuntimeIdentityToken'")
  );
}

export function isStaleGatewayNodeInvokeTurnSourceRejection(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const requestError = asNullableRecord(error);
  if (requestError?.gatewayCode !== ErrorCodes.INVALID_REQUEST) {
    return false;
  }
  const details = asNullableRecord(requestError.details);
  // Only explicit pre-dispatch provenance makes a second invoke safe. Older
  // gateways without this fact must fail rather than risk duplicate execution.
  if (details?.nodeCommandDispatched !== false) {
    return false;
  }
  const message = formatErrorMessage(error);
  if (!message.includes("invalid node.invoke params:")) {
    return false;
  }
  return ["turnSourceChannel", "turnSourceTo", "turnSourceAccountId", "turnSourceThreadId"].some(
    (field) => message.includes(`unexpected property '${field}'`),
  );
}

export function staleGatewayAgentRuntimeIdentityError(cause: unknown): Error {
  return new Error(
    [
      "The running Gateway is from an older OpenClaw build and rejected current agent runtime connection metadata.",
      "Restart the Gateway with `openclaw gateway restart`, then retry.",
    ].join(" "),
    { cause },
  );
}
