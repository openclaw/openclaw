import { Type } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsCancelToolSchema = Type.Object({
  sessionKey: Type.String(),
  reason: Type.Optional(Type.String({ maxLength: 256 })),
});

/**
 * Cancel an active ACP session turn.
 *
 * Interrupts the currently running turn for the given session key.
 * If the session is idle (no active turn), the cancel is a no-op.
 * Does not close the session — the ACP agent remains available for
 * subsequent turns.
 */
export function createSessionsCancelTool(): AnyAgentTool {
  return {
    label: "Sessions Cancel",
    name: "sessions_cancel",
    description:
      "Cancel the active turn of a spawned ACP session. This interrupts the current computation but keeps the session open for future messages. Use the sessionKey from sessions_spawn.",
    parameters: SessionsCancelToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = readStringParam(params, "sessionKey", { required: true });
      const reason = readStringParam(params, "reason") || "agent-requested";

      try {
        await callGateway<{ ok: boolean; key: string }>({
          method: "sessions.cancel",
          params: { key: sessionKey, reason },
          timeoutMs: 15_000,
        });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return jsonResult({
          status: "error",
          error: messageText,
          sessionKey,
        });
      }

      return jsonResult({
        status: "cancelled",
        sessionKey,
      });
    },
  };
}
