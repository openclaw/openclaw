import type { GatewayBrowserClient } from "../gateway.ts";
import type { PluginControlUiEntryPoint, PluginsUiEntryPointsResult } from "../types.ts";

export type PluginUiEntryPointsState = {
  client: GatewayBrowserClient | null;
  pluginUiEntryPoints: PluginControlUiEntryPoint[];
};

export async function loadPluginUiEntryPoints(state: PluginUiEntryPointsState): Promise<void> {
  const client = state.client;
  if (!client) {
    state.pluginUiEntryPoints = [];
    return;
  }
  try {
    const result = (await client.request(
      "plugins.uiEntryPoints",
      {},
    )) as PluginsUiEntryPointsResult;
    state.pluginUiEntryPoints = Array.isArray(result.entryPoints) ? result.entryPoints : [];
  } catch {
    state.pluginUiEntryPoints = [];
  }
}
