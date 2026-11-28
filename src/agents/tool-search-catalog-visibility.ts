import type { ToolRepeatableTarget } from "@openclaw/agent-core";
import { classifyAgentToolSource } from "../plugins/tool-metadata.js";
import { resolveCoreToolFacts } from "./core-tool-facts.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * A core tool family is shown or deferred as one unit: a visible member reads as the whole
 * capability, so a deferred sibling looks unavailable (`sessions_spawn` beside `subagents`).
 * A member sent directly outside the catalog (selector-kept, for example) shows its family too.
 * A member shown for its family never shadows a same-named tool.
 */
export function createFamilyVisibility(params: {
  tools: readonly AnyAgentTool[];
  catalogsTool: (tool: AnyAgentTool) => boolean;
  isVisibleCatalogTool?: (tool: AnyAgentTool) => boolean;
}): (tool: AnyAgentTool) => boolean {
  const coreFamily = (tool: AnyAgentTool) => {
    const { source, sourceName } = classifyAgentToolSource(tool);
    return source === "openclaw" && sourceName === "core"
      ? resolveCoreToolFacts(tool.name)?.catalogFamily
      : undefined;
  };
  const nameCounts = new Map<string, number>();
  const visibleFamilies = new Set<string>();
  for (const tool of params.tools) {
    nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
    const family = coreFamily(tool);
    if (family && (!params.catalogsTool(tool) || params.isVisibleCatalogTool?.(tool) === true)) {
      visibleFamilies.add(family);
    }
  }
  return (tool) => {
    const family = coreFamily(tool);
    return (
      params.isVisibleCatalogTool?.(tool) === true ||
      (family !== undefined && visibleFamilies.has(family) && nameCounts.get(tool.name) === 1)
    );
  };
}

/**
 * dispatch_action's repeat-guard declaration: each trusted catalog tool's own `repeatable`
 * by catalog id, with its name as an alias when unique, so a poll through the dispatcher is
 * exempt exactly as a direct call would be. The repeat guard treats any other selector as a
 * different target, so a call the dispatcher refuses as ambiguous stays counted.
 */
export function dispatchRepeatable(
  entries: readonly ToolSearchCatalogEntry[],
): AnyAgentTool["repeatable"] {
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const targets: Record<string, ToolRepeatableTarget> = {};
  const aliases: Record<string, string> = {};
  for (const { id, name, source, tool } of entries) {
    const repeatable = source === "openclaw" && "repeatable" in tool ? tool.repeatable : undefined;
    if (repeatable === undefined) {
      continue;
    }
    if (repeatable !== true && "dispatch" in repeatable) {
      continue;
    }
    targets[id] = repeatable;
    if (nameCounts.get(name) === 1 && name !== id) {
      aliases[name] = id;
    }
  }
  return Object.keys(targets).length > 0 ? { dispatch: { targets, aliases } } : undefined;
}
