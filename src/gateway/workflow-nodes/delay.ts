/**
 * Delay Node Handler
 *
 * Waits for a specified duration before continuing
 */

import type { WorkflowNodeHandler, NodeInput, NodeOutput, ExecutionContext } from "./types.js";

/**
 * Sleep for a specified duration with abort support
 */
function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new Error("Delay aborted"));
      });
    }
  });
}

export const delayHandler: WorkflowNodeHandler = {
  actionType: "delay",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    const { nodeId, label, config } = input;

    try {
      const durationMs = config.durationMs;

      if (!durationMs || durationMs <= 0) {
        return {
          status: "error",
          error: "Delay node missing or invalid durationMs configuration",
          metadata: {
            nodeId,
            label,
            durationMs,
          },
        };
      }

      // Cap delay at 5 minutes for safety
      const cappedDuration = Math.min(durationMs, 5 * 60 * 1000);

      await sleepWithAbort(cappedDuration, context.abortSignal);

      return {
        status: "success",
        output: context.currentInput, // Pass through
        metadata: {
          nodeId,
          label,
          durationMs: cappedDuration,
          actualDuration: durationMs,
        },
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          nodeId,
          label,
          actionType: "delay",
        },
      };
    }
  },
};
