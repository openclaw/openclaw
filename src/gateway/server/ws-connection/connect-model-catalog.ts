import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type {
  ModelCatalogScope,
  ModelsListResult,
  ModelsSnapshotEvent,
  SessionsResolveResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../../agents/agent-scope-config.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { resolveGatewayAgentSelectionState } from "../../agent-list.js";
import type { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

/** Bootstrap uses ordinary request admission and delivery authority, including deferred identity. */
export async function publishConnectModelCatalog(
  handler: GatewayWsMessageHandlerParams,
  dispatcher: ReturnType<typeof createGatewayAuthenticatedRequestDispatcher>,
): Promise<void> {
  const client = handler.getClient();
  const requestedScope = client?.connect.modelCatalog;
  if (
    client?.connect.client.id !== GATEWAY_CLIENT_IDS.CONTROL_UI ||
    !hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.MODEL_CATALOG_SNAPSHOT) ||
    !requestedScope
  ) {
    return;
  }
  let scope: ModelCatalogScope;
  if ("shortId" in requestedScope) {
    const resolveRequest = {
      type: "req" as const,
      id: `catalog-session:${handler.connId}`,
      method: "sessions.resolve",
      params: requestedScope,
    };
    const resolution: { value?: SessionsResolveResult } = {};
    await dispatcher.dispatch(
      resolveRequest,
      client,
      Buffer.byteLength(JSON.stringify(resolveRequest)),
      undefined,
      (frame) => {
        if (!frame.ok) {
          return handler.send(frame);
        }
        // SAFETY: The registered sessions.resolve handler owns this response contract.
        resolution.value = frame.payload as SessionsResolveResult;
        return { kind: "sent" };
      },
    );
    const resolved = resolution.value;
    if (!resolved?.ok) {
      return;
    }
    scope = { agentId: resolved.agentId, sessionKey: resolved.key };
  } else if (requestedScope.sessionKey) {
    scope = requestedScope;
  } else {
    const cfg = handler.buildRequestContext().getRuntimeConfig();
    const requestedAgentId = requestedScope.agentId
      ? normalizeAgentId(requestedScope.agentId)
      : undefined;
    scope = {
      agentId:
        requestedAgentId && listAgentIds(cfg).includes(requestedAgentId)
          ? requestedAgentId
          : resolveGatewayAgentSelectionState(cfg).defaultId,
    };
  }
  const request = {
    type: "req" as const,
    id: `catalog:${handler.connId}`,
    method: "models.list",
    params: { ...scope, view: "configured" },
  };
  return dispatcher.dispatch(
    request,
    client,
    Buffer.byteLength(JSON.stringify(request)),
    undefined,
    (frame) =>
      handler.send(
        frame.ok
          ? {
              type: "event",
              event: "models.snapshot",
              payload: {
                target: requestedScope,
                scope,
                // SAFETY: This response comes only from the registered models.list handler.
                catalog: frame.payload as ModelsListResult,
              } satisfies ModelsSnapshotEvent,
            }
          : frame,
      ),
  );
}
