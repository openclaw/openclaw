import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import { hasManifestToolAvailability } from "../plugins/manifest-tool-availability.js";
import { isPluginMetadataSnapshotCompatible } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { createMcpServerToolDenyMatcher } from "./tool-policy-match.js";
import type { DeclaredToolAllowlistContext } from "./tool-policy.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

export function buildDeclaredToolAllowlistContext(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  toolDenylist?: string[];
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): DeclaredToolAllowlistContext | undefined {
  const servers = normalizeConfiguredMcpServers(params.config?.mcp?.servers);
  const isDenied = createMcpServerToolDenyMatcher(params.toolDenylist);
  const usedServerNames = new Set<string>();
  const mcpServerNames: string[] = [];
  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value) || value.enabled === false || !name.trim()) {
      continue;
    }
    const safeServerName = sanitizeServerName(name, usedServerNames);
    if (!isDenied(safeServerName)) {
      mcpServerNames.push(safeServerName);
    }
  }

  const pluginIds = new Set<string>();
  const pluginToolNames = new Set<string>();
  if (params.config?.plugins?.enabled !== false) {
    const env = params.env ?? process.env;
    const preparedSnapshot =
      params.metadataSnapshot &&
      params.metadataSnapshot.pluginIds === undefined &&
      isPluginMetadataSnapshotCompatible({
        snapshot: params.metadataSnapshot,
        config: params.config,
        env,
        workspaceDir: params.workspaceDir,
      })
        ? params.metadataSnapshot
        : undefined;
    const snapshot =
      preparedSnapshot ??
      getCurrentPluginMetadataSnapshot({
        config: params.config,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        env,
      });
    if (snapshot) {
      const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
      const denylist = compileGlobPatterns({
        raw: params.toolDenylist,
        normalize: normalizeToolPolicyName,
      });
      const denylistBlocksName = (name: string) => {
        const normalized = normalizeToolPolicyName(name);
        return normalized ? matchesAnyGlobPattern(normalized, denylist) : false;
      };
      for (const plugin of snapshot.manifestRegistry.plugins) {
        if (
          !isManifestPluginAvailableForControlPlane({
            snapshot,
            plugin,
            config: params.config,
            normalizedConfig: normalizedPlugins,
          }) ||
          denylistBlocksName(plugin.id) ||
          matchesAnyGlobPattern("group:plugins", denylist)
        ) {
          continue;
        }
        const availableToolNames = (plugin.contracts?.tools ?? [])
          .filter((toolName) => !denylistBlocksName(toolName))
          .filter((toolName) =>
            hasManifestToolAvailability({
              plugin,
              toolNames: [toolName],
              config: params.config,
              env,
            }),
          )
          .map(normalizeToolPolicyName)
          .filter(Boolean);
        if (availableToolNames.length > 0) {
          pluginIds.add(plugin.id);
          for (const toolName of availableToolNames) {
            pluginToolNames.add(toolName);
          }
        }
      }
    }
  }
  if (mcpServerNames.length === 0 && pluginIds.size === 0 && pluginToolNames.size === 0) {
    return undefined;
  }
  return {
    ...(pluginIds.size > 0 ? { pluginIds: [...pluginIds] } : {}),
    ...(pluginToolNames.size > 0 ? { pluginToolNames: [...pluginToolNames] } : {}),
    ...(mcpServerNames.length > 0 ? { mcpServerNames } : {}),
  };
}
