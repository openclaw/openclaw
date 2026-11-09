import type {
  BoardSnapshot,
  GatewayCoreRequestParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { BoardSessionTarget } from "../../boards/board-store.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { respondBoardError } from "../board-host-tools.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
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
      if (error instanceof SessionMutationAuthorizationChangedError) {
        invocation.respond(false, undefined, error.error);
        return;
      }
      respondBoardError(error, invocation.respond);
    }
  });
}

export function resolveBoardSession(
  params: BoardSessionTarget,
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  admission: "read" | "write" = "write",
): (BoardSessionTarget & { agentId: string }) | undefined {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionStoreTarget(
    cfg,
    params.sessionKey,
    params.agentId,
    admission,
  );
  if (!requested.ok) {
    respond(false, undefined, requested.error);
    return undefined;
  }
  return { ...requested.value, ...(params.component ? { component: params.component } : {}) };
}

export function projectBoardSnapshot<T extends BoardSnapshot>(snapshot: T, agentId: string): T {
  const registry = getActivePluginRegistry();
  // Observer identities distinguish global boards on the wire, never in stored rows.
  return {
    ...snapshot,
    sessionKey: sessionObserverScopeKey(snapshot.sessionKey, agentId),
    widgets: snapshot.widgets.map((widget) => {
      const capabilities = new Set([
        ...(widget.declared?.tools ?? []),
        ...(widget.declared?.actionBindings ?? []).map((binding) => binding.actionId),
        ...(widget.declared?.queries ?? []).map((query) => query.bindingId),
      ]);
      const descriptions: string[] = [];
      const capabilityDescriptions: Record<string, string> = {};
      for (const id of capabilities) {
        const capability =
          registry?.dashboardActionVerbs.get(id) ?? registry?.dashboardDataBindings.get(id);
        if (capability) {
          descriptions.push(`${id}: ${capability.description}`);
          capabilityDescriptions[id] = capability.description;
        }
      }
      // Descriptions follow the active plugin catalog, not the persisted grant.
      // They inform consent without granting access or copying plugin metadata into storage.
      return descriptions.length
        ? {
            ...widget,
            capabilityDescriptions,
            declaredSummary: [...descriptions, ...(widget.declaredSummary ?? [])],
          }
        : widget;
    }),
  };
}

export function broadcastBoardChanged(
  context: GatewayRequestContext,
  session: BoardSessionTarget & { agentId: string },
  { sessionKey, revision }: BoardSnapshot,
  widget?: string,
) {
  context.broadcast(
    "board.changed",
    { sessionKey, revision, ...(widget !== undefined ? { widget } : {}) },
    { sessionKeys: [session.sessionKey], agentId: session.agentId },
  );
}
