import type { PluginsInspectResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { mergeConfiguredBundleMcpServers } from "../agents/bundle-mcp-config.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { resolveOperatorMcpOAuthConfig } from "../agents/mcp-operator-auth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadEnabledBundleMcpConfig } from "./bundle-mcp.js";
import type { PluginMcpAuthDeclarations } from "./plugin-cache-metadata.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "./plugin-cache.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

function resolvePluginMcpAuthDeclarations(
  config: OpenClawConfig,
  metadata: PluginMetadataSnapshot,
): PluginMcpAuthDeclarations {
  const cache = getPluginMetadataSnapshotCache(metadata);
  let byConfig = cache.metadata.mcpAuthDeclarations.get(metadata);
  if (!byConfig) {
    byConfig = new WeakMap();
    cache.metadata.mcpAuthDeclarations.set(metadata, byConfig);
  }
  const configKey = resolveRuntimeConfigCacheKey(config);
  const cached = byConfig.get(config);
  if (cached?.configKey === configKey) {
    return cached.declarations;
  }
  // Reuse metadata ownership within a runtime publication, including when a
  // later publication reuses the same config object with different enablement.
  const bundled = withPluginCache(cache, () =>
    loadEnabledBundleMcpConfig({
      cfg: config,
      workspaceDir: metadata.workspaceDir ?? "",
      manifestRegistry: metadata.manifestRegistry,
    }),
  );
  const byPluginId = new Map<string, { serverName: string; url: string }[]>();
  for (const [serverName, pluginId] of Object.entries(bundled.pluginIdsByServer).toSorted(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const transport = resolveMcpTransportConfig(serverName, bundled.config.mcpServers[serverName], {
      logWarnings: false,
    });
    if (transport?.kind === "http") {
      const servers = byPluginId.get(pluginId) ?? [];
      servers.push({ serverName, url: transport.url });
      byPluginId.set(pluginId, servers);
    }
  }
  const declarations = { byPluginId, bundled };
  byConfig.set(config, { configKey, declarations });
  return declarations;
}

/** Select sign-in from the caller's active inventory, with explicit config taking precedence. */
export function resolveOperatorMcpOAuthConnection(params: {
  config: OpenClawConfig;
  metadata?: PluginMetadataSnapshot;
  serverName: string;
}) {
  // Overrides remain live during an OAuth attempt. Caching their normalized
  // copies would hide edits or deletion from the final authorization check.
  const server = params.metadata
    ? mergeConfiguredBundleMcpServers(
        resolvePluginMcpAuthDeclarations(params.config, params.metadata).bundled,
        { cfg: params.config },
      ).config.mcpServers[params.serverName]
    : params.config.mcp?.servers?.[params.serverName];
  const config = resolveOperatorMcpOAuthConfig(params.serverName, server);
  return config && server ? { config, server } : undefined;
}

/** Project stored auth state only for a plugin's matching, operator-owned connections. */
export async function readPluginMcpAuthStatus(params: {
  config: OpenClawConfig;
  pluginId: string;
  metadata: PluginMetadataSnapshot;
}): Promise<PluginsInspectResult["mcpAuth"]> {
  const declarations = resolvePluginMcpAuthDeclarations(params.config, params.metadata);
  const servers = mergeConfiguredBundleMcpServers(declarations.bundled, {
    cfg: params.config,
  }).config.mcpServers;
  const identities = (declarations.byPluginId.get(params.pluginId) ?? []).flatMap(
    ({ serverName: name, url }) => {
      const configured = resolveOperatorMcpOAuthConfig(name, servers[name]);
      // An operator override can reuse a name for a different service. Only the
      // exact plugin endpoint may present that connection's credential state.
      return configured && configured.url === url
        ? [operatorMcpOAuthIdentity(name, configured.url)]
        : [];
    },
  );
  if (identities.length === 0) {
    return undefined;
  }
  const { readMcpOAuthCredentialsStatuses } = await import("../agents/mcp-oauth.js");
  const statuses = await readMcpOAuthCredentialsStatuses(identities);
  return identities.map((identity, index) => ({
    serverName: identity.serverName,
    state: statuses[index]!.state,
  }));
}
