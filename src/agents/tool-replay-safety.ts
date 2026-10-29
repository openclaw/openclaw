import {
  observeInternalNativeInvocation,
  retainInternalNativeInvocation,
} from "../../packages/agent-core/src/internal-hooks.js";
import {
  getAgentToolExecutionContext,
  getAgentToolAssistantTurnId,
} from "../../packages/agent-core/src/tool-execution-context.js";
import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import { PluginHostObject } from "../plugins/plugin-instance-owned-values.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { getChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { isAsyncStartedToolResult } from "./embedded-agent-tool-results.js";
import { resolveCoreToolFacts } from "./tool-catalog.js";
import { normalizeToolPolicyName } from "./tool-policy-shared.js";
import type { AnyAgentTool } from "./tools/common.js";
import { getProgressCardCommittedSource } from "./tools/progress-card-tool-outcome.js";

type AgentToolReplaySafety = "bounded-read" | "managed-progress";

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

/** Capture concrete source policy at implementation entry, before awaited tool work. */
export function captureAgentToolInvocation(tool: AnyAgentTool, runId: string | undefined) {
  const execution = getAgentToolExecutionContext();
  const turnId = getAgentToolAssistantTurnId();
  const pluginOwned = getPluginToolMeta(tool) !== undefined;
  const channelOwned = getChannelAgentToolMeta(tool) !== undefined;
  const policy = ToolReplaySafety.get(tool);
  const processGeneration = getAgentRunLifecycleGeneration();
  const toolName = tool.name;
  const toolCallId = execution?.toolCall.id;
  const matched = execution?.toolCall.name === toolName;
  return (result: object, successful: boolean): void => {
    const committed = getProgressCardCommittedSource(result);
    // Raw result objects can be reused or returned from inner invocations.
    retainInternalNativeInvocation(result, undefined);
    if (!runId || !turnId || !toolCallId || !matched) {
      return;
    }
    // Repeat-safe plugin declarations do not prove read-only or settled work.
    // Only the concrete native owner may supply bounded-read/committed-progress facts.
    const qualification =
      !successful || pluginOwned || channelOwned || isAsyncStartedToolResult(result)
        ? "unqualified"
        : policy === "managed-progress" &&
            committed?.runId === runId &&
            committed.turnId === turnId &&
            committed.toolCallId === toolCallId &&
            committed.processGeneration === processGeneration
          ? "managed-progress"
          : policy === "bounded-read"
            ? "read"
            : "unqualified";
    observeInternalNativeInvocation(result, {
      runId,
      turnId,
      toolCallId,
      toolName,
      processGeneration,
      qualification,
    });
  };
}
