import { Type } from "@sinclair/typebox";
import { queueEmbeddedPiMessage } from "../pi-embedded.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(Type.String()),
});

export function createSessionsYieldTool(opts?: { sessionId?: string }): AnyAgentTool {
  return {
    label: "Yield",
    name: "sessions_yield",
    description:
      "End your current turn. Use after spawning subagents to receive their results as the next message.",
    parameters: SessionsYieldToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const userMessage = readStringParam(params, "message") || "Turn yielded.";
      const sessionId = opts?.sessionId;
      if (!sessionId) {
        return jsonResult({ status: "error", error: "No session context" });
      }
      const steerText = [
        userMessage,
        "[SYSTEM] Your turn was yielded. The subagent result will arrive as the NEXT message. Do NOT call any tools — just reply with a brief acknowledgment.",
      ].join("\n\n");
      const steered = queueEmbeddedPiMessage(sessionId, steerText);
      if (!steered) {
        return jsonResult({
          status: "error",
          error: "Session not active, not streaming, or compacting",
        });
      }
      return jsonResult({ status: "yielded" });
    },
  };
}
