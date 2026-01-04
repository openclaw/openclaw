import { Type } from "@sinclair/typebox";

import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const GatewayToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("restart"),
    delayMs: Type.Optional(Type.Number()),
    reason: Type.Optional(Type.String()),
  }),
]);

export function createGatewayTool(): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    description:
      "Restart the running gateway process in-place (SIGUSR1) without needing an external supervisor. Use delayMs to avoid interrupting an in-flight reply.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action !== "restart") throw new Error(`Unknown action: ${action}`);

      const delayMsRaw =
        typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
          ? Math.floor(params.delayMs)
          : 2000;
      const delayMs = Math.min(Math.max(delayMsRaw, 0), 60_000);
      const reason =
        typeof params.reason === "string" && params.reason.trim()
          ? params.reason.trim().slice(0, 200)
          : undefined;

      const pid = process.pid;
      setTimeout(() => {
        try {
          process.kill(pid, "SIGUSR1");
        } catch {
          /* ignore */
        }
      }, delayMs);

      return jsonResult({
        ok: true,
        pid,
        signal: "SIGUSR1",
        delayMs,
        reason: reason ?? null,
      });
    },
  };
}
