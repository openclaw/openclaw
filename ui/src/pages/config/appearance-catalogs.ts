import type {
  PluginsListResult,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPageRequest } from "../../lib/page-request.ts";

function createCatalogRead<Value>(method: string, notify: () => void) {
  let key: GatewayBrowserClient | string | null = null;
  let accepted: Value | null = null;
  let receipt: { value: Value | Promise<Value> | null } = { value: null };
  const publish = (value: Value | Promise<Value> | null) => {
    if (receipt.value !== value) {
      receipt = { value };
      notify();
    }
  };
  const request = createPageRequest(notify, {
    task: (
      { client, params }: { client: GatewayBrowserClient; params: Record<string, unknown> },
      { signal },
    ) => {
      const read = client.request<Value>(method, params, { signal });
      publish(read);
      return read;
    },
    onComplete: (value) => {
      accepted = value;
    },
    onError: () => {},
  });
  return {
    get read() {
      return receipt;
    },
    retire() {
      request.cancel();
      key = null;
      // A retired transport must not hold the last accepted presentation open.
      publish(accepted);
    },
    synchronize(
      nextKey: GatewayBrowserClient | string | null,
      client: GatewayBrowserClient | null,
      params: Record<string, unknown> = {},
    ) {
      if (key === nextKey) {
        return;
      }
      request.cancel();
      key = nextKey;
      accepted = null;
      publish(null);
      if (client) {
        void request.run({ client, params });
      }
    },
  };
}

/** Owns Appearance catalog admission and receipts; Solid only derives their display values. */
export function createAppearanceCatalogs(notify: () => void) {
  const plugins = createCatalogRead<PluginsListResult>("plugins.list", notify);
  const labels = createCatalogRead<SessionsCatalogListResult>("sessions.catalog.list", notify);
  return {
    get pluginsRead() {
      return plugins.read;
    },
    get labelsRead() {
      return labels.read;
    },
    retire() {
      plugins.retire();
      labels.retire();
    },
    synchronize(
      active: boolean,
      snapshot: ApplicationGatewaySnapshot,
      agentId: string | null,
      hiddenCatalogIds: ReadonlySet<string>,
    ) {
      const clientFor = (method: string) =>
        active && canCallGatewayMethod(snapshot, method, "operator.read") ? snapshot.client : null;
      const pluginsClient = clientFor("plugins.list");
      plugins.synchronize(pluginsClient, pluginsClient);
      const labelsClient = hiddenCatalogIds.size > 0 ? clientFor("sessions.catalog.list") : null;
      labels.synchronize(
        labelsClient ? `${agentId}\0${[...hiddenCatalogIds].toSorted().join("\0")}` : null,
        labelsClient,
        { ...(agentId ? { agentId } : {}), metadataOnly: true },
      );
    },
  };
}
