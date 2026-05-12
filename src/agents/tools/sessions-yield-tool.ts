import { Type } from "typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(Type.String()),
});

export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  agentSessionKey?: string;
  onYield?: (message: string) => Promise<void> | void;
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
      if (!opts?.sessionId && !opts?.agentSessionKey) {
        return jsonResult({ status: "error", error: "No session context" });
      }
      if (!opts?.onYield) {
        return jsonResult({
          status: "yielded",
          message,
          note: "Yield accepted for this gateway session; this runtime cannot interrupt the current model turn, but queued follow-up events can resume the session after the turn ends.",
        });
      }
      await opts.onYield(message);
      return jsonResult({ status: "yielded", message });
    },
  };
}
