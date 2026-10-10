import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";

type StartupExternalAuthHydrationDeps = {
  listAgentIds: (cfg: OpenClawConfig) => string[];
  resolveAgentDir: (cfg: OpenClawConfig, agentId: string) => string;
  collectConfiguredRefs: (cfg: OpenClawConfig, agentId: string) => readonly { value: string }[];
  hydrate: (cfg: OpenClawConfig, agentDir: string, providers: readonly string[]) => void;
};

export async function hydrateConfiguredExternalCliAuth(params: {
  getConfig: () => OpenClawConfig;
  log: { warn: (msg: string) => void };
  deps?: StartupExternalAuthHydrationDeps | Promise<StartupExternalAuthHydrationDeps>;
}): Promise<OpenClawConfig> {
  const deps: StartupExternalAuthHydrationDeps =
    (await params.deps) ??
    (await Promise.all([
      import("../agents/agent-scope.js"),
      import("../agents/prepared-model-runtime.configured.js"),
      import("../agents/auth-profiles/store-runtime.js"),
      import("../agents/auth-profiles/external-cli-discovery.js"),
    ]).then(([scope, configured, store, external]) => ({
      listAgentIds: scope.listAgentIds,
      resolveAgentDir: scope.resolveAgentDir,
      collectConfiguredRefs: configured.collectPreparedModelRuntimeConfiguredRefs,
      hydrate: (cfg: OpenClawConfig, agentDir: string, providers: readonly string[]) => {
        const discovery = external.externalCliDiscoveryForProviders({ cfg, providers });
        if (discovery.mode === "none") {
          return;
        }
        store.ensureAuthProfileStore(agentDir, {
          config: cfg,
          externalCli: discovery,
          allowKeychainPrompt: false,
          readOnly: true,
          syncExternalCli: false,
        });
      },
    })));
  const cfg = params.getConfig();
  const hydratedDirs = new Set<string>();
  for (const agentId of deps.listAgentIds(cfg)) {
    const providers = deps.collectConfiguredRefs(cfg, agentId).flatMap(({ value }) => {
      const separator = value.indexOf("/");
      return separator > 0 ? [value.slice(0, separator)] : [];
    });
    const agentDir = deps.resolveAgentDir(cfg, agentId);
    if (providers.length === 0 || hydratedDirs.has(agentDir)) {
      continue;
    }
    hydratedDirs.add(agentDir);
    try {
      deps.hydrate(cfg, agentDir, providers);
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
  isCurrent?: () => boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
  startupTrace?: GatewayStartupTrace;
}): Promise<void> {
  const { refreshPreparedModelRuntimeSnapshots } =
    await import("../agents/prepared-model-runtime.js");
  if (params.isCurrent?.() === false) {
    return;
  }
  await refreshPreparedModelRuntimeSnapshots(params.getConfig ?? params.cfg, {
    gatewayLifecycle: true,
    startup: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
    ...(params.isCurrent ? { isPublicationCurrent: params.isCurrent } : {}),
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
    ...(params.workspaceDir ? { defaultWorkspaceDir: params.workspaceDir } : {}),
    ...(params.startupTrace
      ? {
          onBuildStats: (stats) =>
            params.startupTrace?.detail("sidecars.model-runtime-build", [
              ["agentCount", stats.agentCount],
              ["workspaceGroupCount", stats.workspaceGroupCount],
              ["configuredFactsGroupCount", stats.configuredFactsGroupCount],
              ["catalogSourceCount", stats.catalogSourceCount],
              ["credentialGroupCount", stats.credentialGroupCount],
              ["catalogGroupCount", stats.catalogGroupCount],
              ["runtimeRegistryCount", stats.runtimeRegistryCount],
              ["configuredRuntimeModelCount", stats.configuredRuntimeModelCount],
              ["generatedCatalogPluginCount", stats.generatedCatalogPluginCount],
              ["generatedCatalogReadCount", stats.generatedCatalogReadCount],
              ["workspaceFactsMs", stats.workspaceFactsMs],
              ["runtimePluginMs", stats.runtimePluginMs],
              ["pluginMetadataMs", stats.pluginMetadataMs],
              ["staticProviderCatalogMs", stats.staticProviderCatalogMs],
              ["ambientCredentialsMs", stats.ambientCredentialsMs],
              ["agentFactsMs", stats.agentFactsMs],
              ["configuredProjectionMs", stats.configuredProjectionMs],
              ["catalogSourceMs", stats.catalogSourceMs],
              ["registryMs", stats.registryMs],
              ["sourceConcurrencyLimitCount", stats.sourceConcurrencyLimit],
              ["fullCatalogConcurrencyLimitCount", stats.fullCatalogConcurrencyLimit],
            ]),
        }
      : {}),
  });
}
