import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export function hasActiveAgentRuntimeAuthority(
  client: GatewayClient | null,
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">,
  assertCallerCurrent?: () => void,
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
  return !identity || !validate || validate(identity);
}

export function assertActiveAgentRuntimeAuthority(
  client: GatewayClient | null,
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">,
  assertCallerCurrent?: () => void,
): void {
  if (!hasActiveAgentRuntimeAuthority(client, context, assertCallerCurrent)) {
    throw new TypeError("agent runtime authority is no longer active");
  }
}

function ensureActiveAgentRuntimeAuthority(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  respond: RespondFn;
  assertCallerCurrent?: () => void;
}): boolean {
  if (hasActiveAgentRuntimeAuthority(params.client, params.context, params.assertCallerCurrent)) {
    return true;
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
  );
  return false;
}

export function createAgentRuntimeAuthorityGuard(
  client: GatewayClient | null,
  context: GatewayRequestContext,
  respond: RespondFn,
  assertCallerCurrent?: () => void,
) {
  const hasActive = () => hasActiveAgentRuntimeAuthority(client, context, assertCallerCurrent);
  return {
    commitGuard:
      assertCallerCurrent ||
      (client?.internal?.agentRuntimeIdentity && context.validateAgentRuntimeApprovalAuthority)
        ? () => assertActiveAgentRuntimeAuthority(client, context, assertCallerCurrent)
        : undefined,
    ensureActive: () =>
      ensureActiveAgentRuntimeAuthority({ client, context, respond, assertCallerCurrent }),
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
