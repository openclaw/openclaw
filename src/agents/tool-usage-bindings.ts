import { classifyAgentToolSource } from "../plugins/tool-metadata.js";
import { isCodeModeControlTool } from "./code-mode-control-tools.js";
import { isToolUsageWrapper } from "./tool-usage.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Bind exact source identities once, while the native tool surface is assembled. */
export function bindToolUsageIds(
  tools: readonly AnyAgentTool[],
  clientToolNames: readonly string[],
): Map<string, string> {
  const byName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const tool of tools) {
    if (isCodeModeControlTool(tool) || isToolUsageWrapper(tool.name)) {
      ambiguous.add(tool.name);
      continue;
    }
    const { source, sourceName } = classifyAgentToolSource(tool);
    if (source !== "openclaw") {
      ambiguous.add(tool.name);
      continue;
    }
    const toolId = `${source}:${sourceName}:${tool.name}`;
    const previous = byName.get(tool.name);
    if (previous && previous !== toolId) {
      ambiguous.add(tool.name);
    }
    byName.set(tool.name, toolId);
  }
  // A direct client definition wins name shadows but hands execution to the client.
  for (const name of [...ambiguous, ...clientToolNames]) {
    byName.delete(name);
  }
  return byName;
}
