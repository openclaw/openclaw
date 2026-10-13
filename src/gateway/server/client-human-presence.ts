import { isBrowserOperatorUiClient } from "../../utils/message-channel.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../server-constants.js";
import type { WorkerEnvironmentService } from "../worker-environments/service.js";
import type { GatewayClientRegistry } from "./client-registry.js";
import { onGatewayPolicyClientInvalidated } from "./ws-policy-close.js";
import type { GatewayWsClient } from "./ws-types.js";

function hasAuthenticatedControlUiIdentity(clients: GatewayClientRegistry): boolean {
  return [...clients].some(
    (client) =>
      !client.invalidated &&
      client.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
      client.internal?.authenticatedControlUi === true &&
      Boolean(client.authenticatedUserId || client.authenticatedUserProfile) &&
      authorizeOperatorScopesForMethod(
        "sessions.create",
        Array.isArray(client.connect.scopes) ? client.connect.scopes : [],
      ).allowed &&
      isBrowserOperatorUiClient(client.connect.client),
  );
}

/** Bind live Control UI demand and cleanup before requests and reconciliation start. */
export async function startWorkerHumanPresence(params: {
  clients: GatewayClientRegistry;
  service: Pick<WorkerEnvironmentService, "setHumanPresence">;
  log: { warn: (message: string) => void };
  registerSidecar: (sidecar: { stop: () => void }) => void;
}) {
  const { clients, service, log } = params;
  let present = hasAuthenticatedControlUiIdentity(clients);
  const invalidationSubscriptions = new Map<GatewayWsClient, () => void>();
  const refresh = () => {
    const next = hasAuthenticatedControlUiIdentity(clients);
    if (next !== present) {
      present = next;
      void service
        .setHumanPresence(next)
        .catch((error: unknown) =>
          log.warn(`prepared-pool human presence update failed: ${String(error)}`),
        );
    }
  };
  const observeClients = () => {
    for (const [client, unsubscribe] of invalidationSubscriptions) {
      if (!clients.has(client)) {
        unsubscribe();
        invalidationSubscriptions.delete(client);
      }
    }
    for (const client of clients) {
      if (!invalidationSubscriptions.has(client)) {
        // Source revocation precedes transport removal while a policy response is held.
        invalidationSubscriptions.set(client, onGatewayPolicyClientInvalidated(client, refresh));
      }
    }
    refresh();
  };
  const unsubscribe = clients.subscribe(observeClients);
  observeClients();
  params.registerSidecar({
    stop: () => {
      unsubscribe();
      for (const stop of invalidationSubscriptions.values()) {
        stop();
      }
      invalidationSubscriptions.clear();
    },
  });
  // Close a crash-left active marker before worker reconciliation starts.
  await service.setHumanPresence(present);
}
