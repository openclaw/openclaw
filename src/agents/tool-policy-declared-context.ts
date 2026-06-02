import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginId } from "../plugins/config-state.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import type { DeclaredToolAllowlistContext } from "./tool-policy.js";
import { normalizeToolName } from "./tool-policy.js";

function collectConfiguredMcpServerNames(config?: OpenClawConfig): string[] {
  const servers = config?.mcp?.servers;
  if (!isRecord(servers)) {
    return [];
  }
  return Object.entries(servers)
    .filter(([, value]) => isRecord(value))
    .map(([name]) => name.trim())
    .filter(Boolean);
}

function collectDeclaredPluginContext(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Pick<DeclaredToolAllowlistContext, "pluginIds" | "pluginToolNames"> {
  if (params.config?.plugins?.enabled === false) {
    return {};
  }
  const snapshot = loadManifestMetadataSnapshot({
    config: params.config,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  const pluginIds = new Set<string>();
  const pluginToolNames = new Set<string>();
  for (const plugin of snapshot.manifestRegistry.plugins) {
    const pluginId = normalizePluginId(plugin.id);
    if (pluginId) {
      pluginIds.add(pluginId);
    }
    for (const toolName of plugin.contracts?.tools ?? []) {
      const normalizedToolName = normalizeToolName(toolName);
      if (normalizedToolName) {
        pluginToolNames.add(normalizedToolName);
      }
    }
  }
  return { pluginIds, pluginToolNames };
}

export function buildDeclaredToolAllowlistContext(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): DeclaredToolAllowlistContext | undefined {
  const mcpServerNames = collectConfiguredMcpServerNames(params.config);
  const pluginContext = collectDeclaredPluginContext(params);
  const hasDeclaredPlugins =
    Array.from(pluginContext.pluginIds ?? []).length > 0 ||
    Array.from(pluginContext.pluginToolNames ?? []).length > 0;
  if (mcpServerNames.length === 0 && !hasDeclaredPlugins) {
    return undefined;
  }
  return {
    ...pluginContext,
    ...(mcpServerNames.length > 0 ? { mcpServerNames } : {}),
  };
}
