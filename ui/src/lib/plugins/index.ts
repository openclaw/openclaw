// Shared Control UI plugin catalog Gateway contracts.
import type {
  PluginsInstallResult,
  PluginsCatalogGetResult,
  PluginsListResult,
  PluginsSetEnabledParams,
  PluginsSetEnabledResult,
  PluginsUninstallResult,
} from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../config/runtime-config-capability.ts";

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
export type PluginMutationResult = PluginsInstallResult | PluginsSetEnabledResult;

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

/** Serialize every plugin config write without discarding structured Gateway failures. */
export async function runPluginConfigMutation<T>(
  runtimeConfig: Pick<RuntimeConfigCapability, "runExternalMutation">,
  expectedClient: GatewayBrowserClient,
  task: (client: GatewayBrowserClient) => Promise<T>,
  options: { canDispatch?: () => boolean; dispatchError?: string } = {},
): Promise<{ value: T; refreshError: string | null }> {
  let taskError: Error | undefined;
  const mutation = await runtimeConfig.runExternalMutation(async (client) => {
    if (client !== expectedClient) {
      throw new Error("Connection changed before the plugin update started.");
    }
    try {
      return await task(client);
    } catch (error) {
      // Preserve structured Gateway failures for the caller.
      taskError = error instanceof Error ? error : new Error(String(error));
      throw taskError;
    }
  }, options);
  if (!mutation.ok) {
    throw taskError ?? new Error(mutation.error);
  }
  return {
    value: mutation.value,
    refreshError: mutation.refresh.ok ? null : mutation.refresh.error,
  };
}
