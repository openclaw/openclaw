import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { BundleMcpConfig } from "./bundle-mcp.js";
import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistry, getActivePluginRegistryWorkspaceDir } from "./runtime.js";

export type PluginMcpServerConfigResult = {
  config: BundleMcpConfig;
};

function isPluginEnabledByConfig(pluginId: string, cfg?: OpenClawConfig): boolean {
  const entry = cfg?.plugins?.entries?.[pluginId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return true;
  }
  return (entry as { enabled?: unknown }).enabled !== false;
}

function isWorkspaceMatch(params: { workspaceDir?: string; activeWorkspaceDir?: string }): boolean {
  if (!params.workspaceDir || !params.activeWorkspaceDir) {
    return true;
  }
  return path.resolve(params.workspaceDir) === path.resolve(params.activeWorkspaceDir);
}

export function loadEnabledPluginMcpServerConfig(params?: {
  workspaceDir?: string;
  cfg?: OpenClawConfig;
  registry?: PluginRegistry | null;
}): PluginMcpServerConfigResult {
  const usingActiveRegistry = params?.registry === undefined;
  const registry = params?.registry ?? getActivePluginRegistry();
  if (!registry) {
    return { config: { mcpServers: {} } };
  }
  if (
    usingActiveRegistry &&
    !isWorkspaceMatch({
      workspaceDir: params?.workspaceDir,
      activeWorkspaceDir: getActivePluginRegistryWorkspaceDir(),
    })
  ) {
    return { config: { mcpServers: {} } };
  }
  const loadedPluginIds = new Set(
    registry.plugins
      .filter(
        (plugin) =>
          plugin.enabled &&
          plugin.status === "loaded" &&
          isPluginEnabledByConfig(plugin.id, params?.cfg),
      )
      .map((plugin) => plugin.id),
  );
  const mcpServers = Object.fromEntries(
    registry.mcpServers
      .filter((entry) => loadedPluginIds.has(entry.pluginId))
      .toSorted((left, right) => {
        const nameOrder = left.name.localeCompare(right.name);
        if (nameOrder !== 0) {
          return nameOrder;
        }
        return left.pluginId.localeCompare(right.pluginId);
      })
      .map((entry) => {
        const server =
          entry.rootDir &&
          typeof entry.server.cwd !== "string" &&
          typeof entry.server.workingDirectory !== "string"
            ? { ...entry.server, cwd: entry.rootDir }
            : { ...entry.server };
        return [entry.name, server];
      }),
  );
  return { config: { mcpServers } };
}
