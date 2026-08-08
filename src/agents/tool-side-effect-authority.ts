import {
  agentToolReplaySafetyOptions,
  resolveAgentToolInstanceReplayPolicy,
} from "./agent-tool-instance-replay.js";
import { resolveBoundToolExecutionAttribution } from "./agent-tools.before-tool-call.attribution.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { isCodeModeControlTool } from "./code-mode-control-tools.js";
import { resolveToolCallReplaySafe } from "./tool-mutation.js";
import { isAgentToolReplaySafe } from "./tool-replay-safety.js";

const unsafeExecutionAttributions = new WeakSet<object>();

/** Record monotonic authority once an unsafe tool body is about to start. */
export function recordUnsafeToolExecutionAuthority(
  tool: { name?: string },
  args: unknown,
  ctx?: HookContext,
): void {
  const instancePolicy = resolveAgentToolInstanceReplayPolicy(tool);
  const instanceReplaySafe = isAgentToolReplaySafe(tool, agentToolReplaySafetyOptions);
  if (
    resolveToolCallReplaySafe({
      toolName: tool.name ?? "",
      args,
      instanceReplaySafe,
      structuredReplaySafe: !instancePolicy.externallyOwned,
      codeModeControl: isCodeModeControlTool(tool as object),
    })
  ) {
    return;
  }
  const attribution = resolveBoundToolExecutionAttribution(ctx);
  if (attribution) {
    unsafeExecutionAttributions.add(attribution);
  }
}

/** Missing private attribution cannot prove that repair remains side-effect free. */
export function hasUnsafeToolExecutionAuthority(attribution: object | undefined): boolean {
  return !attribution || unsafeExecutionAttributions.has(attribution);
}
