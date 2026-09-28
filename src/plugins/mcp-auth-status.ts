import type { PluginsInspectResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { resolveOperatorMcpOAuthConfig } from "../agents/mcp-operator-auth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadEnabledBundleMcpConfig } from "./bundle-mcp.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

/** Project stored auth state only for a plugin's matching, operator-owned connections. */
export async function readPluginMcpAuthStatus(params: {
  config: OpenClawConfig;
  pluginId: string;
  metadata: Pick<PluginMetadataSnapshot, "manifestRegistry" | "workspaceDir">;
}): Promise<PluginsInspectResult["mcpAuth"]> {
  if (!params.config.mcp?.servers) {
    return undefined;
  }
  const bundled = loadEnabledBundleMcpConfig({
    cfg: params.config,
    // Supplying the prepared registry avoids workspace discovery here.
    workspaceDir: params.metadata.workspaceDir ?? "",
    manifestRegistry: params.metadata.manifestRegistry,
  });
  const identities = Object.entries(bundled.pluginIdsByServer)
    .filter(([, owner]) => owner === params.pluginId)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([name]) => {
      const configured = resolveOperatorMcpOAuthConfig(name, params.config.mcp?.servers?.[name]);
      const declaration = resolveMcpTransportConfig(name, bundled.config.mcpServers[name], {
        logWarnings: false,
      });
      // An operator override can reuse a name for a different service. Only the
      // exact plugin endpoint may present that connection's credential state.
      return configured && declaration?.kind === "http" && configured.url === declaration.url
        ? [operatorMcpOAuthIdentity(name, configured.url)]
        : [];
    });
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
