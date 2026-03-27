import { normalizeToolName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import { getActivePluginRegistry, getActivePluginRegistryKey } from "./runtime.js";
import type { OpenClawPluginToolContext, OpenClawPluginToolExecuteContext } from "./types.js";

const log = createSubsystemLogger("plugins");

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

/**
 * Build the lightweight execution context forwarded to plugin tool `execute`
 * calls as the third argument.  This contains only identity/session fields —
 * never config or secrets.
 */
function buildExecuteContext(ctx: OpenClawPluginToolContext): OpenClawPluginToolExecuteContext {
  return {
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
    messageChannel: ctx.messageChannel,
    agentAccountId: ctx.agentAccountId,
    sandboxed: ctx.sandboxed,
  };
}

/**
 * Wrap a plugin tool's `execute` method so the tool-context is forwarded as
 * the third argument: `execute(callId, params, context)`.
 *
 * This is the "Level 1" injection path — plugins that declare a third parameter
 * on their execute function receive identity context (agentId, sessionKey, etc.)
 * automatically, without needing to close over the factory context or rely on
 * environment variables.
 */
function wrapToolWithExecuteContext(
  tool: AnyAgentTool,
  execCtx: OpenClawPluginToolExecuteContext,
): AnyAgentTool {
  const original = tool.execute;
  if (!original) return tool;
  return Object.create(tool, {
    execute: {
      value: (callId: string, params: unknown) => original.call(tool, callId, params, execCtx),
      writable: true,
      configurable: true,
    },
  });
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
  const effectiveConfig = applyTestPluginDefaults(params.context.config ?? {}, env);
  const normalized = normalizePluginsConfig(effectiveConfig.plugins);
  if (!normalized.enabled) {
    return [];
  }

  const activeRegistry = getActivePluginRegistry();
  const registry =
    getActivePluginRegistryKey() && activeRegistry
      ? activeRegistry
      : loadOpenClawPlugins({
          config: effectiveConfig,
          workspaceDir: params.context.workspaceDir,
          runtimeOptions: params.allowGatewaySubagentBinding
            ? {
                allowGatewaySubagentBinding: true,
              }
            : undefined,
          env,
          logger: createPluginLoaderLogger(log),
        });

  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const blockedPlugins = new Set<string>();
  const execCtx = buildExecuteContext(params.context);

  for (const entry of registry.tools) {
    if (blockedPlugins.has(entry.pluginId)) {
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
      resolved = entry.factory(params.context);
    } catch (err) {
      log.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
      continue;
    }
    if (!resolved) {
      if (entry.names.length > 0) {
        log.debug(
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
      const wrapped = wrapToolWithExecuteContext(tool, execCtx);
      pluginToolMeta.set(wrapped, {
        pluginId: entry.pluginId,
        optional: entry.optional,
      });
      tools.push(wrapped);
    }
  }

  return tools;
}
