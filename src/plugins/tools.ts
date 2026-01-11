import type { AnyAgentTool } from "../agents/tools/common.js";
import { createSubsystemLogger } from "../logging.js";
import { loadClawdbotPlugins } from "./loader.js";
import type { ClawdbotPluginToolContext } from "./types.js";

const log = createSubsystemLogger("plugins");

export function resolvePluginTools(params: {
  context: ClawdbotPluginToolContext;
  existingToolNames?: Set<string>;
}): AnyAgentTool[] {
  const registry = loadClawdbotPlugins({
    config: params.context.config,
    workspaceDir: params.context.workspaceDir,
    logger: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
      debug: (msg) => log.debug(msg),
    },
  });

  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();

  for (const entry of registry.tools) {
    let resolved: AnyAgentTool | AnyAgentTool[] | null | undefined = null;
    try {
      resolved = entry.factory(params.context);
    } catch (err) {
      log.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
      continue;
    }
    if (!resolved) continue;
    const list = Array.isArray(resolved) ? resolved : [resolved];
    for (const tool of list) {
      if (existing.has(tool.name)) {
        log.warn(`plugin tool name conflict (${entry.pluginId}): ${tool.name}`);
        continue;
      }
      existing.add(tool.name);
      tools.push(tool);
    }
  }

  return tools;
}
