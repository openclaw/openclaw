import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { BundleMcpConfig } from "./bundle-mcp.js";
import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistry, getActivePluginRegistryWorkspaceDir } from "./runtime.js";

export type PluginMcpServerConfigResult = {
  config: BundleMcpConfig;
};

type PluginMcpServerConfigNormalizationResult =
  | { ok: true; server: Record<string, unknown> }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPluginEnabledByConfig(pluginId: string, cfg?: OpenClawConfig): boolean {
  const entry = cfg?.plugins?.entries?.[pluginId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return true;
  }
  return (entry as { enabled?: unknown }).enabled !== false;
}

function isWorkspaceMatch(params: { workspaceDir?: string; activeWorkspaceDir?: string }): boolean {
  if (!params.workspaceDir) {
    return true;
  }
  if (!params.activeWorkspaceDir) {
    return false;
  }
  return path.resolve(params.workspaceDir) === path.resolve(params.activeWorkspaceDir);
}

export function normalizePluginRegisteredMcpServerConfig(params: {
  name: string;
  server: unknown;
  rootDir?: string;
}): PluginMcpServerConfigNormalizationResult {
  if (!isRecord(params.server)) {
    return {
      ok: false,
      error: `MCP server "${params.name}" registration must be an object`,
    };
  }

  if (typeof params.server.url === "string" && params.server.url.trim().length > 0) {
    return {
      ok: false,
      error: `MCP server "${params.name}" must use managed stdio transport, not URL transport`,
    };
  }

  if (
    typeof params.server.transport === "string" &&
    params.server.transport.trim().length > 0 &&
    params.server.transport !== "stdio"
  ) {
    return {
      ok: false,
      error: `MCP server "${params.name}" must use stdio transport (received ${params.server.transport})`,
    };
  }

  if (typeof params.server.command !== "string" || params.server.command.trim().length === 0) {
    return {
      ok: false,
      error: `MCP server "${params.name}" must use stdio transport with a non-empty command`,
    };
  }

  const normalized = {
    ...params.server,
    command: params.server.command.trim(),
  };
  if (
    params.rootDir &&
    typeof normalized.cwd !== "string" &&
    typeof normalized.workingDirectory !== "string"
  ) {
    normalized.cwd = params.rootDir;
  }

  return {
    ok: true,
    server: normalized,
  };
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
