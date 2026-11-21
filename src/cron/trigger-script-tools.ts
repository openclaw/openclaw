import type { AnyAgentTool } from "../agents/tools/common.js";

/**
 * A headless script has no later turn to collect a backgrounded command, so exec waits for its
 * command within the script's deadline unless the script asks for `background: true`. The
 * process tool keeps its granted operations, for example to stop what a command left running.
 */
export function headlessScriptTool(tool: AnyAgentTool, deadline: number): AnyAgentTool {
  if (tool.name !== "exec") {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, input, signal, onUpdate) => {
      const { yieldMs: _yield, ...args } = input as Record<string, unknown>;
      const remainingSeconds = Math.max(1, Math.floor((deadline - performance.now()) / 1_000));
      // A shorter timeout the script asked for still applies; the deadline caps longer ones.
      const requested = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : Infinity;
      const timeoutSeconds = Math.min(requested, remainingSeconds);
      if (args.background === true) {
        return tool.execute(toolCallId, { ...args, timeoutSeconds }, signal, onUpdate);
      }
      const result = await tool.execute(
        toolCallId,
        { ...args, awaitResults: true, timeoutSeconds },
        signal,
        onUpdate,
      );
      const details = result.details as
        | { status?: unknown; exitCode?: unknown; aggregated?: unknown }
        | undefined;
      if (details?.status !== "completed" && details?.status !== "failed") {
        throw new Error("exec did not finish within the automation script's deadline");
      }
      const output = typeof details.aggregated === "string" ? details.aggregated : "";
      // The full result stays for stored scripts; exitCode and output are the short form.
      return {
        ...result,
        details: { ...details, exitCode: details.exitCode ?? null, output },
      };
    },
  };
}
