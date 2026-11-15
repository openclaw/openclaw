import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { captureActiveEmbeddedRunPersonalToolParticipants } from "../agents/embedded-agent-runner/run-state.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { isSessionTargetMethod } from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

/** Session dispatch retains its execution owner without consulting the participant roster. */
export function resolveSessionRuntimeAuthority(params: {
  method: string;
  runtimeIdentity: AgentRuntimeIdentity | undefined;
  context: GatewayRequestContext;
}) {
  const caller = getGatewayToolCallerIdentity();
  const { method, runtimeIdentity, context } = params;
  if (caller?.personalToolIdentityScoped || !isSessionTargetMethod(method)) {
    return undefined;
  }
  const assertCallerCurrent = captureGatewayToolCallerAssertion(method);
  if (!runtimeIdentity && !assertCallerCurrent) {
    return undefined;
  }
  const checked = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
      );
    }
  };
  const activeTurn = checked(() =>
    runtimeIdentity
      ? captureActiveEmbeddedRunPersonalToolParticipants(runtimeIdentity, {
          allowMissingRegistry: true,
        })
      : undefined,
  );
  const assertCurrent = () =>
    checked(() => {
      assertCallerCurrent?.();
      activeTurn?.assertCurrent();
      if (
        runtimeIdentity &&
        context.validateAgentRuntimeApprovalAuthority?.(runtimeIdentity) !== true
      ) {
        throw new Error("agent runtime authority is no longer active");
      }
    });
  assertCurrent();
  return { assertCurrent };
}

/** Expected authority refusals are request policy outcomes, not handler failures. */
export function resolveSessionRuntimeAuthorityRequest(
  options: Pick<GatewayRequestOptions, "req" | "client" | "respond" | "context">,
): ReturnType<typeof resolveSessionRuntimeAuthority> | null {
  try {
    return resolveSessionRuntimeAuthority({
      method: options.req.method,
      runtimeIdentity: options.client?.internal?.agentRuntimeIdentity,
      context: options.context,
    });
  } catch (error) {
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
    );
    return null;
  }
}
