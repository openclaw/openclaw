import { Type } from "typebox";
import { jsonResult, readStringParam } from "./common.js";
const SessionsYieldToolSchema = Type.Object({
    message: Type.Optional(Type.String()),
});
export function createSessionsYieldTool(opts) {
    return {
        label: "Yield",
        name: "sessions_yield",
        description: "End your current turn. Use after spawning subagents to receive their results as the next message.",
        parameters: SessionsYieldToolSchema,
        execute: async (_toolCallId, args) => {
            const params = args;
            const message = readStringParam(params, "message") || "Turn yielded.";
            if (!opts?.sessionId) {
                return jsonResult({ status: "error", error: "No session context" });
            }
            if (!opts?.onYield) {
                return jsonResult({ status: "error", error: "Yield not supported in this context" });
            }
            await opts.onYield(message);
            return jsonResult({ status: "yielded", message });
        },
    };
}
