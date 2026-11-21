import type { AnyAgentTool } from "../agents/tools/common.js";

/**
 * A headless script has no later turn to collect a backgrounded command, so exec waits for its
 * command within the script's deadline unless the script asks for `background` or `durable`. The
 * process tool keeps its granted operations, for example to stop what a command left running.
 */
export function headlessScriptTool(tool: AnyAgentTool, deadline: number): AnyAgentTool {
  if (tool.name !== "exec") {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, input, signal, onUpdate) => {
      // SAFETY: exec validates its own parameters; this reads only optional scalar fields.
      const args = input as Record<string, unknown>;
      // Background and durable launches keep their own contract; the process tool manages them.
      if (args.background === true || args.durable === true) {
        return tool.execute(toolCallId, input, signal, onUpdate);
      }
      const { yieldMs: _yield, ...foreground } = args;
      const remainingSeconds = Math.max(1, Math.floor((deadline - performance.now()) / 1_000));
      // A shorter timeout the script asked for still applies; the deadline caps longer ones.
      const requested = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : Infinity;
      const timeoutSeconds = Math.min(requested, remainingSeconds);
      const result = await tool.execute(
        toolCallId,
        { ...foreground, awaitResults: true, timeoutSeconds },
        signal,
        onUpdate,
      );
      // SAFETY: exec results carry ExecToolDetails; every field read below is checked.
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
