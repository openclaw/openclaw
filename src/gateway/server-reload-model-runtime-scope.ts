import { listAgentIds } from "../agents/agent-roster.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { normalizeProviderMapKeys } from "../agents/models-config.merge.js";
import { pruneRemovedProviderPluginModelCatalogs } from "../agents/plugin-model-catalog.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../routing/session-key.js";

/** Returns affected agent ids when every meaningful reload path is agent-entry-local. */
export function resolveReloadAgentIds(
  changedPaths: readonly string[],
): ReadonlySet<string> | undefined {
  if (changedPaths.length === 0) {
    return undefined;
  }
  const agentIds = new Set<string>();
  for (const path of changedPaths) {
    if (path === "meta" || path.startsWith("meta.")) {
      continue;
    }
    const match = /^agents\.entries\.([^.]+)(?:\.|$)/.exec(path);
    if (!match?.[1]) {
      return undefined;
    }
    agentIds.add(normalizeAgentId(match[1]));
  }
  return agentIds.size > 0 ? agentIds : undefined;
}

/** Apply known endpoint removals before publishing the replacement model inventory. */
export async function pruneRemovedProviderModelCatalogs(
  previousConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
): Promise<void> {
  const previousProviders = normalizeProviderMapKeys(previousConfig.models?.providers);
  const nextProviders = normalizeProviderMapKeys(nextConfig.models?.providers);
  const removedProviderBaseUrls = Object.fromEntries(
    Object.entries(previousProviders).flatMap(([id, provider]) =>
      provider.baseUrl && !Object.hasOwn(nextProviders, id) ? [[id, provider.baseUrl]] : [],
    ),
  );
  if (Object.keys(removedProviderBaseUrls).length === 0) {
    return;
  }
  const agentDirs = new Set(
    listAgentIds(previousConfig).map((id) => resolveAgentDir(previousConfig, id)),
  );
  for (const agentDir of agentDirs) {
    await pruneRemovedProviderPluginModelCatalogs({ agentDir, removedProviderBaseUrls });
  }
}

export function refreshModelRuntimeAfterHotReload(params: {
  config: OpenClawConfig;
  agentIds: ReadonlySet<string> | undefined;
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
  isPublicationCurrent?: () => boolean;
}): Promise<void> {
  return refreshPreparedModelRuntimeSnapshots(params.config, {
    catalogMode: "static",
    joinSupersedingPublication: true,
    ...(params.isPublicationCurrent ? { isPublicationCurrent: params.isPublicationCurrent } : {}),
    allowGatewaySubagentBinding: true,
    ...(params.agentIds ? { agentIds: params.agentIds } : {}),
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
  });
}
