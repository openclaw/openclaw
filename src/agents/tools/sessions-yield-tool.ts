import { Type } from "typebox";
import { recordSessionRecoveryCheckpoint } from "../session-recovery-state.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(Type.String()),
});

export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  onYield?: (message: string) => Promise<void> | void;
  recovery?: {
    enabled?: boolean;
    taskId?: string;
    actorId?: string;
    workspaceId?: string;
    repoId?: string;
  };
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
        return jsonResult({ status: "error", error: "Yield not supported in this context" });
      }
      await opts.onYield(message);
      let recoveryStatus: "recorded" | "skipped" | "error" | undefined;
      if (opts.recovery?.enabled) {
        try {
          const checkpoint = recordSessionRecoveryCheckpoint({
            taskId: opts.recovery.taskId ?? `session:${opts.sessionId}`,
            actorId: opts.recovery.actorId ?? "agent",
            eventType: "handoff_written",
            summary: message,
            sessionId: opts.sessionId,
            workspaceId: opts.recovery.workspaceId,
            repoId: opts.recovery.repoId,
            nextResumeAction: "Ask the user whether to continue, correct context, or start fresh.",
          });
          recoveryStatus = checkpoint.status;
        } catch {
          recoveryStatus = "error";
        }
      }
      return jsonResult({
        status: "yielded",
        message,
        ...(recoveryStatus ? { recovery: recoveryStatus } : {}),
      });
    },
  };
}
