import type { PluginsInspectResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { resolveOperatorMcpOAuthConfig } from "../agents/mcp-operator-auth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
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
  const cached = byConfig.get(config);
  if (cached) {
    return cached;
  }
  // Metadata and runtime config are immutable publications. Reuse their derived
  // ownership until either changes; OAuth credentials remain a separate live read.
  const bundled = withPluginCache(cache, () =>
    loadEnabledBundleMcpConfig({
      cfg: config,
      workspaceDir: metadata.workspaceDir ?? "",
      manifestRegistry: metadata.manifestRegistry,
    }),
  );
  const declarations = new Map<string, { serverName: string; url: string }[]>();
  for (const [serverName, pluginId] of Object.entries(bundled.pluginIdsByServer).toSorted(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const transport = resolveMcpTransportConfig(serverName, bundled.config.mcpServers[serverName], {
      logWarnings: false,
    });
    if (transport?.kind === "http") {
      const servers = declarations.get(pluginId) ?? [];
      servers.push({ serverName, url: transport.url });
      declarations.set(pluginId, servers);
    }
  }
  byConfig.set(config, declarations);
  return declarations;
}

/** Project stored auth state only for a plugin's matching, operator-owned connections. */
export async function readPluginMcpAuthStatus(params: {
  config: OpenClawConfig;
  pluginId: string;
  metadata: PluginMetadataSnapshot;
}): Promise<PluginsInspectResult["mcpAuth"]> {
  if (!params.config.mcp?.servers) {
    return undefined;
  }
  const declarations = resolvePluginMcpAuthDeclarations(params.config, params.metadata);
  const identities = (declarations.get(params.pluginId) ?? []).flatMap(
    ({ serverName: name, url }) => {
      const configured = resolveOperatorMcpOAuthConfig(name, params.config.mcp?.servers?.[name]);
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
