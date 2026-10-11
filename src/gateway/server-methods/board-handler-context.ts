import type {
  BoardSnapshot,
  GatewayCoreRequestParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { BoardSessionTarget } from "../../boards/board-store.js";
import { respondBoardError } from "../board-host-tools.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export function defineBoardMethod<Method extends keyof GatewayCoreRequestParams>(
  ...[method, validate, handler]: Parameters<typeof defineValidatedGatewayMethod<Method>>
) {
  return defineValidatedGatewayMethod(method, validate, async (invocation) => {
    try {
      await handler(invocation);
    } catch (error) {
      respondBoardError(error, invocation.respond);
    }
  });
}

export function resolveBoardSession(
  params: { sessionKey: string; agentId?: string | undefined },
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): Required<BoardSessionTarget> | undefined {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionStoreTarget(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    respond(false, undefined, requested.error);
    return undefined;
  }
  return requested.value;
}

export function projectBoardSnapshot<T extends BoardSnapshot>(snapshot: T, agentId: string): T {
  // Observer identities distinguish global boards on the wire, never in stored rows.
  return { ...snapshot, sessionKey: sessionObserverScopeKey(snapshot.sessionKey, agentId) };
}

export function broadcastBoardChanged(
  context: GatewayRequestContext,
  session: Required<BoardSessionTarget>,
  { sessionKey, revision }: BoardSnapshot,
  widget?: string,
) {
  context.broadcast(
    "board.changed",
    { sessionKey, revision, ...(widget !== undefined ? { widget } : {}) },
    { sessionKeys: [session.sessionKey], agentId: session.agentId },
  );
}
