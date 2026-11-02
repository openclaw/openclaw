import { PluginHostObject } from "../plugins/plugin-instance-owned-values.js";
import { resolveCoreToolFacts } from "./tool-catalog.js";
import { normalizeToolPolicyName } from "./tool-policy-shared.js";

type AgentToolReplaySafety = "bounded-read";

/** Private source-instance metadata survives only the host's canonical tool copies. */
class ToolReplaySafety extends PluginHostObject {
  #kind: AgentToolReplaySafety;

  constructor(tool: object, kind: AgentToolReplaySafety) {
    super(tool);
    this.#kind = kind;
  }

  static get(tool: object): AgentToolReplaySafety | undefined {
    return #kind in tool ? tool.#kind : undefined;
  }

  static set(tool: object, kind: AgentToolReplaySafety): void {
    if (#kind in tool) {
      tool.#kind = kind;
    } else {
      void new ToolReplaySafety(tool, kind);
    }
  }
}

export function bindAgentToolReplaySafety<T extends object>(
  tool: T,
  kind: AgentToolReplaySafety,
): T {
  ToolReplaySafety.set(tool, kind);
  return tool;
}

export function copyAgentToolReplaySafety(source: object, target: object): void {
  const kind = ToolReplaySafety.get(source);
  if (kind) {
    ToolReplaySafety.set(target, kind);
  }
}

type NamedTool = { name?: string };

function groupUniqueToolsByName(tools: NamedTool[]): Map<string, NamedTool | undefined> {
  const toolsByName = new Map<string, NamedTool | undefined>();
  for (const tool of tools) {
    const name = normalizeToolPolicyName(tool.name ?? "");
    if (!name) {
      continue;
    }
    toolsByName.set(name, toolsByName.has(name) ? undefined : tool);
  }
  return toolsByName;
}

/**
 * Tool names are not ownership boundaries. Callers must reject plugin/channel
 * instances before using this audited core-tool allowlist.
 */
export function isAgentToolReplaySafe(
  tool: { name?: string },
  options?: { declaredReplaySafe?: (tool: { name?: string }) => boolean | undefined },
): boolean {
  if (options?.declaredReplaySafe?.(tool) === false) {
    return false;
  }
  const safety = resolveCoreToolFacts(normalizeToolPolicyName(tool.name ?? ""))?.replay;
  return ToolReplaySafety.get(tool) === "bounded-read" || safety === "both" || safety === "blind";
}

/**
 * Name-only tool events are safe only when one concrete registered instance
 * owns the name. Duplicate/shadowed names fail closed.
 */
export function collectReplaySafeToolNames(
  tools: NamedTool[],
  options?: { declaredReplaySafe?: (tool: { name?: string }) => boolean | undefined },
): Set<string> {
  const replaySafeNames = new Set<string>();
  for (const [name, tool] of groupUniqueToolsByName(tools)) {
    if (tool && isAgentToolReplaySafe(tool, options)) {
      replaySafeNames.add(name);
    }
  }
  return replaySafeNames;
}

/** Bind name-only terminal events to the one concrete owner-declared side-effecting tool. */
export function collectSideEffectToolOwners(
  tools: NamedTool[],
  options: { declaredOwner: (tool: NamedTool) => string | undefined },
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [name, tool] of groupUniqueToolsByName(tools)) {
    const owner = tool ? options.declaredOwner(tool) : undefined;
    if (owner) {
      owners.set(name, owner);
    }
  }
  return owners;
}
