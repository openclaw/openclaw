import { normalizeToolName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import {
  isPluginRegistryLoadInFlight,
  loadOpenClawPlugins,
  type PluginLoadOptions,
} from "./loader.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import type { OpenClawPluginToolContext } from "./types.js";

type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
};

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();

export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

export function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void {
  const meta = pluginToolMeta.get(source);
  if (meta) {
    pluginToolMeta.set(target, meta);
  }
}

function normalizeAllowlist(list?: string[]) {
  return new Set((list ?? []).map(normalizeToolName).filter(Boolean));
}

function isOptionalToolAllowed(params: {
  toolName: string;
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return false;
  }
  const toolName = normalizeToolName(params.toolName);
  if (params.allowlist.has(toolName)) {
    return true;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey)) {
    return true;
  }
  return params.allowlist.has("group:plugins");
}

function resolvePluginToolRegistry(params: { loadOptions: PluginLoadOptions }) {
  // Always perform a fresh non-activating plugin load for tool factories.
  // Long-lived agent/tool server processes can otherwise retain stale plugin
  // tool closures from an older active runtime registry across rebuilds or
  // gateway restarts, which makes live tool execution diverge from the current
  // code on disk.
  //
  // But if an equivalent plugin load is already in flight, preserve the old
  // degrade-quietly behavior for helper/runtime callers instead of surfacing a
  // hard reentry error from loadOpenClawPlugins().
  if (isPluginRegistryLoadInFlight(params.loadOptions)) {
    return undefined;
  }
  return loadOpenClawPlugins({
    ...params.loadOptions,
    activate: false,
    cache: false,
  });
}

export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool[] {
  // Fast path: when plugins are effectively disabled, avoid discovery/jiti entirely.
  // This matters a lot for unit tests and for tool construction hot paths.
  const env = params.env ?? process.env;
  const baseConfig = applyTestPluginDefaults(params.context.config ?? {}, env);
  const context = resolvePluginRuntimeLoadContext({
    config: baseConfig,
    env,
    workspaceDir: params.context.workspaceDir,
  });
  const normalized = normalizePluginsConfig(context.config.plugins);
  if (!normalized.enabled) {
    return [];
  }

  const runtimeOptions = params.allowGatewaySubagentBinding
    ? { allowGatewaySubagentBinding: true as const }
    : undefined;
  const loadOptions = buildPluginRuntimeLoadOptions(context, { runtimeOptions });
  const registry = resolvePluginToolRegistry({
    loadOptions,
  });
  if (!registry) {
    return [];
  }

  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const blockedPlugins = new Set<string>();

  for (const entry of registry.tools) {
    if (blockedPlugins.has(entry.pluginId)) {
      continue;
    }
    const pluginIdKey = normalizeToolName(entry.pluginId);
    if (existingNormalized.has(pluginIdKey)) {
      const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
      if (!params.suppressNameConflicts) {
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
      }
      blockedPlugins.add(entry.pluginId);
      continue;
    }
    let resolved: AnyAgentTool | AnyAgentTool[] | null | undefined = null;
    try {
      resolved = entry.factory(params.context);
    } catch (err) {
      context.logger.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
      continue;
    }
    if (!resolved) {
      if (entry.names.length > 0) {
        context.logger.debug?.(
          `plugin tool factory returned null (${entry.pluginId}): [${entry.names.join(", ")}]`,
        );
      }
      continue;
    }
    const listRaw = Array.isArray(resolved) ? resolved : [resolved];
    const list = entry.optional
      ? listRaw.filter((tool) =>
          isOptionalToolAllowed({
            toolName: tool.name,
            pluginId: entry.pluginId,
            allowlist,
          }),
        )
      : listRaw;
    if (list.length === 0) {
      continue;
    }
    const nameSet = new Set<string>();
    for (const tool of list) {
      if (nameSet.has(tool.name) || existing.has(tool.name)) {
        const message = `plugin tool name conflict (${entry.pluginId}): ${tool.name}`;
        if (!params.suppressNameConflicts) {
          context.logger.error(message);
          registry.diagnostics.push({
            level: "error",
            pluginId: entry.pluginId,
            source: entry.source,
            message,
          });
        }
        continue;
      }
      nameSet.add(tool.name);
      existing.add(tool.name);
      pluginToolMeta.set(tool, {
        pluginId: entry.pluginId,
        optional: entry.optional,
      });
      tools.push(tool);
    }
  }

  return tools;
}
