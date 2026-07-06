/**
 * Sleep/wait built-in tool.
 *
 * Suspends the current turn for N seconds by yielding and scheduling a
 * one-shot wake event.  This allows the agent to pause without burning tokens
 * or spamming poll loops.
 *
 * Behaviour:
 *   1. Schedule a one-shot wake event after `seconds` via a one-shot cron `at` job
 *   2. Return `{ status: "yielded" }` — the existing yield detector in
 *      `subagent-yield-output.ts` already handles this generically
 *   3. The gateway resumes the session when the wake fires
 *
 * Linked issue: openclaw/openclaw#101190
 */

import { Type } from "typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const SleepToolSchema = Type.Object({
  seconds: Type.Number({
    minimum: 1,
    maximum: 600,
    description:
      "Seconds to sleep before resuming (1–600). Use instead of polling loops for long-running external processes.",
  }),
  message: Type.Optional(
    Type.String({
      description: "Message injected when waking (reminder context so the agent can resume).",
    }),
  ),
});

/** Creates the sleep tool for runtimes that support yield callbacks. */
export function createSleepTool(opts?: {
  sessionId?: string;
  /** End the current turn (same callback as sessions_yield). */
  onYield?: (message: string) => Promise<void> | void;
  /**
   * Schedule a one-shot wake event. The implementer creates a transient cron
   * `at` job (or equivalent wake mechanism) that injects `message` as a system
   * event into the session after `seconds` has elapsed.
   *
   * If omitted the tool yields immediately without scheduling — useful for
   * testing or runtimes without cron support.
   */
  scheduleWake?: (seconds: number, message: string) => Promise<void> | void;
}): AnyAgentTool {
  return {
    label: "Sleep",
    name: "sleep",
    description:
      "Pause execution for N seconds without burning tokens. The turn ends immediately and resumes when the timer fires (max 600 s). Use instead of polling loops for long-running external processes.",
    parameters: SleepToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const seconds = readNumberParam(params, "seconds") ?? 60;
      const message =
        readStringParam(params, "message") ?? "Sleep timer fired. Resume pending work.";

      if (!opts?.sessionId) {
        return jsonResult({ status: "error", error: "No session context" });
      }

      if (!opts?.onYield) {
        return jsonResult({
          status: "error",
          error: "Yield not supported in this context",
        });
      }

      if (seconds > 600) {
        return jsonResult({
          status: "error",
          error: "Max sleep duration is 600 seconds. Use cron for longer waits.",
        });
      }

      if (seconds < 1) {
        return jsonResult({
          status: "error",
          error: "Sleep duration must be at least 1 second.",
        });
      }

      // Schedule wake event before yielding the turn
      if (opts.scheduleWake) {
        await opts.scheduleWake(seconds, message);
      }

      // Yield — the generic yield detector sees `{ status: "yielded" }` and
      // maps it to stopReason: "end_turn", exactly like sessions_yield.
      await opts.onYield(`Sleeping for ${seconds}s: ${message}`);

      return jsonResult({
        status: "yielded",
        message: `Sleeping for ${seconds}s. Will resume with: ${message}`,
        seconds,
      });
    },
  };
}
