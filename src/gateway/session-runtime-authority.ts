import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { captureActiveEmbeddedRunPersonalToolParticipants } from "../agents/embedded-agent-runner/run-state.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { isSessionTargetMethod } from "./session-method-policy.js";

/** A personal-tool turn's session request starts only while that turn is active; checked once. */
export function resolveSessionRuntimeAuthorityRequest(
  options: Pick<GatewayRequestOptions, "req" | "client" | "respond">,
): boolean {
  const runtimeIdentity = options.client?.internal?.agentRuntimeIdentity;
  if (
    !runtimeIdentity ||
    getGatewayToolCallerIdentity()?.personalToolIdentityScoped ||
    !isSessionTargetMethod(options.req.method)
  ) {
    return true;
  }
  try {
    captureActiveEmbeddedRunPersonalToolParticipants(runtimeIdentity, {
      allowMissingRegistry: true,
    });
    return true;
  } catch (error) {
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
    );
    return false;
  }
}
