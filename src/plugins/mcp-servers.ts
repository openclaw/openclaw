import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import type { BundleMcpDiagnostic, BundleMcpServerConfig } from "./bundle-mcp.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { resolveRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import type { OpenClawPluginMcpServerOptions, OpenClawPluginToolContext } from "./types.js";

const log = createSubsystemLogger("plugins");

function normalizeMcpServerName(name: string): string {
  return name.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(values: string[] | undefined): string[] | undefined {
  const normalized = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function applyMcpServerOptions(
  server: Record<string, unknown>,
  options: OpenClawPluginMcpServerOptions | undefined,
): BundleMcpServerConfig {
  const openclaw = isRecord(server.openclaw) ? server.openclaw : {};
  const toolNamePrefix = options?.toolNamePrefix?.trim();
  const allowTools = normalizeStringList(options?.allowTools);
  const denyTools = normalizeStringList(options?.denyTools);
  const toolOverrides = options?.toolOverrides;

  return {
    ...server,
    openclaw: {
      ...openclaw,
      ...(toolNamePrefix ? { toolNamePrefix } : {}),
      ...(allowTools ? { allowTools } : {}),
      ...(denyTools ? { denyTools } : {}),
      ...(toolOverrides && Object.keys(toolOverrides).length > 0 ? { toolOverrides } : {}),
    },
  };
}

function createPluginMcpServerContext(params: {
  config: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  workspaceDir?: string;
}): OpenClawPluginToolContext {
  return {
    config: params.config,
    runtimeConfig: params.runtimeConfig,
    workspaceDir: params.workspaceDir,
  };
}

export function resolvePluginMcpServers(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): { mcpServers: Record<string, BundleMcpServerConfig>; diagnostics: BundleMcpDiagnostic[] } {
  const env = params.env ?? process.env;
  const baseConfig = applyTestPluginDefaults(params.config ?? {}, env);
  const effectiveConfig = applyPluginAutoEnable({ config: baseConfig, env }).config;
  const normalized = normalizePluginsConfig(effectiveConfig.plugins);
  if (!normalized.enabled) {
    return { mcpServers: {}, diagnostics: [] };
  }

  const loadOptions: PluginLoadOptions = {
    config: effectiveConfig,
    workspaceDir: params.workspaceDir,
    env,
    logger: {
      debug: (message) => log.debug(message),
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
      error: (message) => log.error(message),
    },
  };
  const registry = resolveRuntimePluginRegistry(loadOptions);
  if (!registry || registry.mcpServers.length === 0) {
    return { mcpServers: {}, diagnostics: [] };
  }

  const runtimeSnapshot = getActiveSecretsRuntimeSnapshot();
  const context = createPluginMcpServerContext({
    config: effectiveConfig,
    runtimeConfig: runtimeSnapshot?.config,
    workspaceDir: params.workspaceDir,
  });
  const diagnostics: BundleMcpDiagnostic[] = [];
  const mcpServers: Record<string, BundleMcpServerConfig> = {};

  for (const entry of registry.mcpServers) {
    const serverName = normalizeMcpServerName(entry.serverName);
    if (!serverName) {
      continue;
    }
    try {
      const resolved = entry.factory(context);
      if (!resolved) {
        continue;
      }
      mcpServers[serverName] = applyMcpServerOptions(resolved, entry.options);
    } catch (error) {
      const message = `plugin MCP server "${serverName}" failed: ${error instanceof Error ? error.message : String(error)}`;
      diagnostics.push({ pluginId: entry.pluginId, message });
      log.warn(message);
    }
  }

  return { mcpServers, diagnostics };
}
