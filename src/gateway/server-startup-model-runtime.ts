import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";

export async function hydrateConfiguredExternalCliAuth(params: {
  getConfig: () => OpenClawConfig;
  log: { warn: (msg: string) => void };
}): Promise<OpenClawConfig> {
  const [scope, configured, store, external] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../agents/prepared-model-runtime.configured.js"),
    import("../agents/auth-profiles/store-runtime.js"),
    import("../agents/auth-profiles/external-cli-discovery.js"),
  ]);
  const cfg = params.getConfig();
  const hydratedDirs = new Set<string>();
  for (const agentId of scope.listAgentIds(cfg)) {
    const providers = configured
      .collectPreparedModelRuntimeConfiguredRefs(cfg, agentId)
      .flatMap(({ value }) => {
        const separator = value.indexOf("/");
        return separator > 0 ? [value.slice(0, separator)] : [];
      });
    const agentDir = scope.resolveAgentDir(cfg, agentId);
    if (providers.length === 0 || hydratedDirs.has(agentDir)) {
      continue;
    }
    hydratedDirs.add(agentDir);
    try {
      const discovery = external.externalCliDiscoveryForProviders({ cfg, providers });
      if (discovery.mode === "none") {
        continue;
      }
      await store.ensureAuthProfileStoreAsync(agentDir, {
        config: cfg,
        externalCli: discovery,
        allowKeychainPrompt: false,
        readOnly: true,
        syncExternalCli: false,
      });
    } catch (error) {
      params.log.warn(
        `startup external CLI auth hydration failed for agent ${agentId}: ${String(error)}`,
      );
    }
  }
  return cfg;
}

export async function publishConfiguredModelRuntimeSnapshots(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig | Promise<OpenClawConfig>;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
  startupTrace?: GatewayStartupTrace;
}): Promise<void> {
  const { refreshPreparedModelRuntimeSnapshots } =
    await import("../agents/prepared-model-runtime.js");
  await refreshPreparedModelRuntimeSnapshots(params.getConfig ?? params.cfg, {
    gatewayLifecycle: true,
    startup: true,
    joinSupersedingPublication: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
    ...(params.workspaceDir ? { defaultWorkspaceDir: params.workspaceDir } : {}),
    ...(params.startupTrace
      ? {
          onBuildStats: ({ sourceConcurrencyLimit, fullCatalogConcurrencyLimit, ...metrics }) =>
            params.startupTrace?.detail("sidecars.model-runtime-build", [
              ...Object.entries(metrics),
              ["sourceConcurrencyLimitCount", sourceConcurrencyLimit],
              ["fullCatalogConcurrencyLimitCount", fullCatalogConcurrencyLimit],
            ]),
        }
      : {}),
  });
}
