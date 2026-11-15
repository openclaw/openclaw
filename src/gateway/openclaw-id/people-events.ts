// Keyless People invalidations reuse the Gateway's connection and run owners.
// Every send checks current scope and membership; a former owner is not a recipient.
import { onGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import { GATEWAY_EVENT_ID_PEOPLE_CHANGED } from "../events.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import type { GatewayBroadcastToConnIdsFn } from "../server-broadcast-types.js";
import type { GatewayClientRegistry } from "../server/client-registry.js";
import { resolveOpenClawIdClientChannel, resolveOpenClawIdClientPeerKey } from "./channel.js";
import type { OpenClawIdService } from "./service.js";

/** Binds People invalidation producers for this Gateway lifetime; no periodic refresh. */
export function startOpenClawIdPeopleEvents(params: {
  clients: GatewayClientRegistry;
  service: OpenClawIdService;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  log: { warn: (message: string) => void };
}): { stop: () => void } {
  let stopped = false;
  const publish = async () => {
    const candidates = await Promise.all(
      [...params.clients].map(async (client) => ({
        client,
        currentOwner: await params.service.prepareOwnerClientCheck(
          resolveOpenClawIdClientChannel(client),
          resolveOpenClawIdClientPeerKey(client),
        ),
      })),
    );
    if (stopped) {
      return;
    }
    // No await between the current authority check and targeted transport publication.
    const connIds = new Set(
      candidates
        .filter(
          ({ client, currentOwner }) =>
            params.clients.has(client) &&
            !client.invalidated &&
            client.connectionKind !== "worker" &&
            !client.connectionSignal?.aborted &&
            (client.connect.role ?? "operator") === "operator" &&
            authorizeOperatorScopesForMethod("openclawId.people", client.connect.scopes ?? [])
              .allowed &&
            currentOwner(),
        )
        .map(({ client }) => client.connId),
    );
    if (connIds.size > 0) {
      params.broadcastToConnIds(GATEWAY_EVENT_ID_PEOPLE_CHANGED, {}, connIds);
    }
  };
  const changed = () => {
    void publish().catch((error: unknown) =>
      params.log.warn(`openclaw-id: People invalidation failed: ${String(error)}`),
    );
  };
  const unsubscribe = [
    params.service.onPeopleChanged(changed),
    params.clients.subscribeChanges(changed),
    // RPC source registration/removal and execution-start publish from their owners.
    onGatewayWorkMetricsChanged(changed),
  ];
  return {
    stop: () => {
      stopped = true;
      unsubscribe.forEach((stop) => stop());
    },
  };
}
