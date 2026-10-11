import type {
  PluginsInstallResult,
  PluginsCatalogGetResult,
  PluginsListResult,
  PluginsSetEnabledParams,
  PluginsUninstallResult,
} from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createConfigMutationRunner } from "../config/config-mutation-runner.ts";

export type {
  PluginCatalogEntry as PluginCatalogItem,
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDeclaredSurface,
  PluginHookGrant,
  PluginInspectSource,
  PluginOperatorGrants,
  PluginsInspectResult,
  PluginsInstallParams as PluginInstallRequest,
  PluginsCatalogBrowseResult as PluginDiscoveryResult,
  PluginsCatalogGetResult as PluginDiscoveryDetailResult,
  PluginsListResult as PluginListResult,
} from "../../../../packages/gateway-protocol/src/schema/plugins.js";
export type PluginMutationResult = PluginsInstallResult;

export function loadPluginCatalog(client: GatewayBrowserClient): Promise<PluginsListResult> {
  return client.request<PluginsListResult>("plugins.list", {});
}

export function loadPluginDiscoveryDetail(
  client: GatewayBrowserClient,
  id: string,
  signal?: AbortSignal,
  version?: string,
): Promise<PluginsCatalogGetResult> {
  return client.request<PluginsCatalogGetResult>(
    "plugins.catalog.get",
    { id, ...(version ? { version } : {}) },
    signal ? { signal } : undefined,
  );
}

export function uninstallPlugin(
  client: GatewayBrowserClient,
  pluginId: string,
): Promise<PluginsUninstallResult> {
  return client.request<PluginsUninstallResult>("plugins.uninstall", { pluginId });
}

export function setPluginEnabled(
  client: GatewayBrowserClient,
  pluginId: string,
  enabled: boolean,
  options?: Pick<PluginsSetEnabledParams, "acknowledgeCapabilities">,
): Promise<PluginMutationResult> {
  return client.request<PluginMutationResult>("plugins.setEnabled", {
    pluginId,
    enabled,
    ...options,
  });
}

export const runPluginConfigMutation = createConfigMutationRunner(
  "Connection changed before the plugin update started.",
);
