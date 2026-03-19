import { appendFileSync } from "node:fs";
import { normalizeToolName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { getGlobalPluginRegistry } from "./hook-runner-global.js";
import { loadOpenClawPlugins } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import type { OpenClawPluginToolContext } from "./types.js";

const log = createSubsystemLogger("plugins");

type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
};

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();

export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
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

function tracePluginToolStage(stage: string): void {
  const stageLogPath = process.env.OPENCLAW_STAGE_LOG?.trim();
  if (!stageLogPath) {
    return;
  }
  try {
    appendFileSync(stageLogPath, `${new Date().toISOString()} ${stage}\n`);
  } catch {
    // Best-effort tracing only. Never let debug logging change runtime behavior.
  }
}

export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  suppressNameConflicts?: boolean;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool[] {
  // Fast path: when plugins are effectively disabled, avoid discovery/jiti entirely.
  // This matters a lot for unit tests and for tool construction hot paths.
  const env = params.env ?? process.env;
  const effectiveConfig = applyTestPluginDefaults(params.context.config ?? {}, env);
  const normalized = normalizePluginsConfig(effectiveConfig.plugins);
  if (!normalized.enabled) {
    tracePluginToolStage("plugin-tools-disabled");
    return [];
  }

  // Agent runtime paths eagerly bootstrap plugins before tool construction, so reusing the
  // global registry avoids a second full discovery/import/register pass on the same turn.
  tracePluginToolStage("plugin-tools-pre-registry");
  const registry =
    getGlobalPluginRegistry() ??
    loadOpenClawPlugins({
      config: effectiveConfig,
      workspaceDir: params.context.workspaceDir,
      env,
      logger: createPluginLoaderLogger(log),
    });
  tracePluginToolStage(`plugin-tools-post-registry count=${registry.tools.length}`);

  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const blockedPlugins = new Set<string>();

  for (const entry of registry.tools) {
    tracePluginToolStage(`plugin-tools-entry-start plugin=${entry.pluginId}`);
    if (blockedPlugins.has(entry.pluginId)) {
      tracePluginToolStage(`plugin-tools-entry-skip-blocked plugin=${entry.pluginId}`);
      continue;
    }
    const pluginIdKey = normalizeToolName(entry.pluginId);
    if (existingNormalized.has(pluginIdKey)) {
      const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
      if (!params.suppressNameConflicts) {
        log.error(message);
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
      tracePluginToolStage(`plugin-tools-entry-factory-start plugin=${entry.pluginId}`);
      resolved = entry.factory(params.context);
      tracePluginToolStage(`plugin-tools-entry-factory-done plugin=${entry.pluginId}`);
    } catch (err) {
      log.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
      tracePluginToolStage(`plugin-tools-entry-factory-error plugin=${entry.pluginId}`);
      continue;
    }
    if (!resolved) {
      tracePluginToolStage(`plugin-tools-entry-empty plugin=${entry.pluginId}`);
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
      tracePluginToolStage(`plugin-tools-entry-filtered plugin=${entry.pluginId}`);
      continue;
    }
    const nameSet = new Set<string>();
    for (const tool of list) {
      if (nameSet.has(tool.name) || existing.has(tool.name)) {
        const message = `plugin tool name conflict (${entry.pluginId}): ${tool.name}`;
        if (!params.suppressNameConflicts) {
          log.error(message);
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
    tracePluginToolStage(`plugin-tools-entry-done plugin=${entry.pluginId} count=${list.length}`);
  }

  tracePluginToolStage(`plugin-tools-complete count=${tools.length}`);
  return tools;
}
