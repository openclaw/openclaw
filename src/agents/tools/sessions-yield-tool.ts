import { Type } from "typebox";
import {
  buildSessionsYieldCompletionOutput,
  type SessionsYieldCompletionOutput,
} from "../completion-truth.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(Type.String()),
});

export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  onYield?: (message: string) => Promise<void> | void;
  onCompletionTruth?: (output: SessionsYieldCompletionOutput) => Promise<void> | void;
}): AnyAgentTool {
  return {
    label: "Yield",
    name: "sessions_yield",
    description:
      "End your current turn. Use after spawning subagents to receive their results as the next message.",
    parameters: SessionsYieldToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message") || "Turn yielded.";
      if (!opts?.sessionId) {
        return jsonResult({ status: "error", error: "No session context" });
      }
      if (!opts?.onYield) {
        return jsonResult({
          status: "error",
          error: "Yield not supported in this context",
        });
      }
      const completionOutput = buildSessionsYieldCompletionOutput({
        message,
        sessionId: opts.sessionId,
        toolCallId: _toolCallId,
      });
      try {
        void Promise.resolve(opts.onCompletionTruth?.(completionOutput)).catch(() => {
          // Completion truth is observability metadata. It must never block the
          // control-plane yield callback that cleanly aborts the active run.
        });
      } catch {
        // Completion truth is observability metadata. It must never block the
        // control-plane yield callback that cleanly aborts the active run.
      }
      await opts.onYield(message);
      return jsonResult({ status: "yielded", message });
    },
  };
}
