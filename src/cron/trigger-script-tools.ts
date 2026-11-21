import type { AnyAgentTool } from "../agents/tools/common.js";

/**
 * A headless script has no later turn to collect a background process: exec waits for its
 * command within the script's deadline, and the process tool is unavailable.
 */
export function headlessScriptTool(tool: AnyAgentTool, deadline: number): AnyAgentTool {
  if (tool.name === "process") {
    return {
      ...tool,
      description: "Unavailable in automation scripts: exec waits for its command to finish.",
      execute: async () => {
        throw new Error(
          "process is unavailable in automation scripts: exec now waits for the command and returns { exitCode, output }. Remove the process call.",
        );
      },
    };
  }
  if (tool.name !== "exec") {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, input, signal, onUpdate) => {
      const {
        yieldMs: _yield,
        background: _background,
        ...args
      } = input as Record<string, unknown>;
      const remainingSeconds = Math.max(1, Math.floor((deadline - performance.now()) / 1_000));
      const result = await tool.execute(
        toolCallId,
        { ...args, awaitResults: true, timeoutSeconds: remainingSeconds },
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
      // `status` and `aggregated` stay for stored scripts written against the full result.
      return {
        content: result.content,
        details: {
          exitCode: details.exitCode ?? null,
          output,
          status: details.status,
          aggregated: output,
        },
      };
    },
  };
}
