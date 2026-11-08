import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import type { PluginsInventoryRead, PluginsRouteData } from "./route-data.ts";

function isPluginsInventoryReadCurrent(
  inventory: PluginsInventoryRead,
  gateway: GatewayPageBinding,
): boolean {
  return (
    !inventory.signal.aborted &&
    gateway.isRouteDataCurrent(inventory) &&
    inventory.generation === gateway.snapshot?.pluginCapabilities?.generation
  );
}

function readPluginsInventory(
  client: GatewayBrowserClient,
  inventory: PluginsInventoryRead | undefined,
  gateway: GatewayPageBinding,
  signal: AbortSignal,
): Promise<PluginListResult> {
  if (!inventory) {
    return client.request<PluginListResult>("plugins.list", {}, { signal });
  }
  // A refresh retires publication through catalogTask; the route owns this transport.
  return inventory.result.then((result) => {
    signal.throwIfAborted();
    const generation = gateway.snapshot?.pluginCapabilities?.generation;
    if (
      isPluginsInventoryReadCurrent(inventory, gateway) &&
      ("error" in result ||
        generation === undefined ||
        (result.value.generation ?? -1) >= generation)
    ) {
      if ("error" in result) {
        throw result.error;
      }
      return result.value;
    }
    return client.request<PluginListResult>("plugins.list", {}, { signal });
  });
}

export function takePluginsInventoryRead(data: PluginsRouteData, gateway: GatewayPageBinding) {
  // Transfer the early read once; a cached route revisit needs fresh inventory.
  const inventory = data.inventory;
  data.inventory = undefined;
  return inventory && isPluginsInventoryReadCurrent(inventory, gateway) ? inventory : undefined;
}

export function createPluginsInventoryRequest(
  gateway: GatewayPageBinding,
  notify: () => void,
  handlers: { onComplete: (value: PluginListResult) => void; onError: (error: unknown) => void },
) {
  return createPageRequest(notify, {
    task: (
      [client, inventory]: readonly [GatewayBrowserClient, PluginsInventoryRead?],
      { signal },
    ) => readPluginsInventory(client, inventory, gateway, signal),
    ...handlers,
  });
}
