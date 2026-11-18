import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export function hasActiveAgentRuntimeAuthority(
  client: GatewayClient | null,
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">,
  assertCallerCurrent?: () => void,
  scope?: "lifecycle",
): boolean {
  try {
    assertCallerCurrent?.();
  } catch {
    return false;
  }
  const identity = client?.internal?.agentRuntimeIdentity;
  const validate = context.validateAgentRuntimeApprovalAuthority;
  // Production dispatch always supplies the validator. Lightweight direct-handler
  // contexts have no live authority owner and therefore no identity to invalidate.
  return !identity || !validate || validate(identity, scope);
}

export function assertActiveAgentRuntimeAuthority(
  client: GatewayClient | null,
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">,
  assertCallerCurrent?: () => void,
  scope?: "lifecycle",
): void {
  if (!hasActiveAgentRuntimeAuthority(client, context, assertCallerCurrent, scope)) {
    throw new TypeError("agent runtime authority is no longer active");
  }
}

export function createAgentRuntimeAuthorityGuard(
  client: GatewayClient | null,
  context: GatewayRequestContext,
  respond: RespondFn,
  assertCallerCurrent?: () => void,
) {
  const hasActive = () => hasActiveAgentRuntimeAuthority(client, context, assertCallerCurrent);
  return {
    // Stop/release and exact turn ownership still fence effects; policy stays admitted.
    commitGuard:
      client?.internal?.agentRuntimeIdentity && context.validateAgentRuntimeApprovalAuthority
        ? () => assertActiveAgentRuntimeAuthority(client, context, assertCallerCurrent, "lifecycle")
        : assertCallerCurrent,
    ensureActive() {
      if (hasActive()) {
        return true;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
      );
      return false;
    },
    handleClosedError(error: unknown): undefined {
      if (error instanceof TypeError && !hasActive()) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return undefined;
      }
      throw error;
    },
    hasActive,
  };
}
