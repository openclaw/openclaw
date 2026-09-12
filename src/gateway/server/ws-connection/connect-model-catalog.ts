import { GATEWAY_CLIENT_IDS } from "../../../../packages/gateway-protocol/src/client-info.js";
import type {
  ModelsListResult,
  ModelsSnapshotEvent,
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
  if (client?.connect.client.id !== GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return;
  }
  const cfg = handler.buildRequestContext().getRuntimeConfig();
  const requestedAgentId = client.connect.modelCatalogAgentId
    ? normalizeAgentId(client.connect.modelCatalogAgentId)
    : undefined;
  const agentId =
    requestedAgentId && listAgentIds(cfg).includes(requestedAgentId)
      ? requestedAgentId
      : resolveGatewayAgentSelectionState(cfg).defaultId;
  const request = {
    type: "req" as const,
    id: `catalog:${handler.connId}:${agentId}`,
    method: "models.list",
    params: { agentId, view: "configured" },
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
                agentId,
                // The registered models.list handler owns this response contract.
                catalog: frame.payload as ModelsListResult,
              } satisfies ModelsSnapshotEvent,
            }
          : frame,
      ),
  );
}
