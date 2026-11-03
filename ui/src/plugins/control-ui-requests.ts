import type { ControlUiRequests } from "../../../src/plugin-sdk/control-ui-requests.js";
import type { ApplicationContext } from "../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../app/operator-access.ts";
import { isCronInventoryInvalidation as cronInventoryInvalidation } from "../lib/cron/inventory-connection.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { createGatewaySetSyncLifecycle } from "../lib/gateway-set-sync-lifecycle.ts";
import { subscribeGatewaySnapshot } from "../lib/gateway-snapshot-observation.ts";

/** Activation-bound transport adapter. Native connection and retry owners remain authoritative. */
export function createControlUiRequests(params: {
  current: () => Pick<ApplicationContext, "gateway">;
  signal: AbortSignal;
  retain: (dispose: () => void) => () => void;
}): ControlUiRequests {
  const current = () => {
    const gateway = params.current().gateway;
    params.signal.throwIfAborted();
    return gateway;
  };
  let revision = 0;
  const requests: ControlUiRequests = {
    get revision() {
      current();
      return revision;
    },
    hasScope(scope) {
      const auth = current().snapshot.hello?.auth ?? null;
      return scope === "operator.admin"
        ? hasOperatorAdminAccess(auth)
        : hasOperatorReadAccess(auth);
    },
    canCall(method, requiredScope, requireAdvertisement = true) {
      return canCallGatewayMethod(current().snapshot, method, requiredScope, {
        requireAdvertisement,
      });
    },
    isCronInventoryInvalidation(event) {
      return cronInventoryInvalidation({ type: "event", ...event }, current().snapshot);
    },
    capture() {
      const gateway = current();
      const snapshot = gateway.snapshot;
      const client = snapshot.client;
      if (!client || snapshot.phase !== "connected") {
        return null;
      }
      const epoch = gateway.connectionRevision;
      const generation = client.connectionGeneration;
      const auth = JSON.stringify(snapshot.hello?.auth ?? null);
      const methods = JSON.stringify(snapshot.hello?.features?.methods ?? null);
      const isCurrent = () =>
        !params.signal.aborted &&
        params.current().gateway === gateway &&
        gateway.snapshot.client === client &&
        gateway.snapshot.hello === snapshot.hello &&
        gateway.snapshot.phase === "connected" &&
        gateway.connectionRevision === epoch &&
        client.connectionGeneration === generation &&
        JSON.stringify(gateway.snapshot.hello?.auth ?? null) === auth &&
        JSON.stringify(gateway.snapshot.hello?.features?.methods ?? null) === methods;
      return {
        isCurrent,
        async request<T>(
          method: string,
          values: unknown = {},
          options?: { signal?: AbortSignal; timeoutMs?: number },
        ) {
          if (!isCurrent()) {
            throw new Error("The connection changed. Retry the request.");
          }
          const result = await client.request<T>(method, values, options);
          if (!isCurrent()) {
            throw new Error("The connection changed. Retry the request.");
          }
          return result;
        },
      };
    },
    subscribe(notify) {
      const gateway = current();
      let captured = requests.capture();
      return params.retain(
        subscribeGatewaySnapshot(gateway, "authority", () => {
          if (!params.signal.aborted && (!captured || !captured.isCurrent())) {
            captured = requests.capture();
            revision += 1;
            notify();
          }
        }),
      );
    },
    subscribeEvents(notify) {
      return params.retain(
        current().subscribeEvents((event) => {
          if (!params.signal.aborted) {
            notify(event);
          }
        }),
      );
    },
    createSetSync(options) {
      const gateway = current();
      const lifecycle = createGatewaySetSyncLifecycle(gateway, options);
      params.retain(() => {
        lifecycle.resetRetry();
        lifecycle.detach();
      });
      return {
        get attached() {
          return lifecycle.attached;
        },
        get requestAcknowledged() {
          return lifecycle.requestAcknowledged;
        },
        resetRetry: lifecycle.resetRetry,
        scheduleRetry(callback) {
          current();
          lifecycle.scheduleRetry(() => {
            if (!params.signal.aborted) {
              current();
              callback();
            }
          });
        },
        sync: lifecycle.sync,
        schedule: lifecycle.schedule,
        clearRequest: lifecycle.clearRequest,
        matchesRequest: (signature) => lifecycle.matchesRequest(signature),
        isRequestCurrent: () => lifecycle.requestHello === gateway.snapshot.hello,
        send(method, values, signature, callbacks) {
          const client = current().snapshot.client;
          if (!client) {
            throw new Error("The connection changed. Retry the request.");
          }
          lifecycle.send(client, method, values, signature, callbacks);
        },
        attach() {
          current();
          lifecycle.attach();
        },
        detach: () => lifecycle.detach(),
      };
    },
  };
  return requests;
}
