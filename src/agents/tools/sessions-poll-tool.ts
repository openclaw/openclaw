import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { listSubagentRunsForRequester, type SubagentRunRecord } from "../subagent-registry.js";
import { jsonResult, readStringParam } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const SessionsPollToolSchema = Type.Object({
  sessionKey: Type.String({
    description: "Session key of the subagent to poll",
  }),
});

const IDLE_THRESHOLD_MS = 60_000;

function resolveStatus(
  run: SubagentRunRecord,
  nowMs: number,
): "running" | "idle" | "completed" | "error" {
  if (run.endedAt) {
    return run.outcome?.status === "error" ? "error" : "completed";
  }
  const lastActivity = run.startedAt ?? run.createdAt;
  const idleMs = nowMs - lastActivity;
  if (idleMs > IDLE_THRESHOLD_MS) {
    return "idle";
  }
  return "running";
}

export function createSessionsPollTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_poll",
    description:
      "Lightweight progress check for a spawned subagent session. " +
      "Returns the current status (running/idle/completed/error), " +
      "last activity time, and runtime. No file I/O — uses in-memory registry only.",
    parameters: SessionsPollToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = readStringParam(params, "sessionKey", { required: true });

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey
        ? resolveInternalSessionKey({
            key: opts.agentSessionKey,
            alias,
            mainKey,
          })
        : alias;

      // Find the subagent run record
      const runs = listSubagentRunsForRequester(requesterSessionKey);
      const run = runs.find((r) => r.childSessionKey === sessionKey);

      if (!run) {
        return jsonResult({
          status: "not_found",
          sessionKey,
          error: `No subagent run found for session key: ${sessionKey}`,
        });
      }

      const now = Date.now();
      const status = resolveStatus(run, now);
      const startedAt = run.startedAt ?? run.createdAt;
      const lastActivity = run.endedAt ?? startedAt;
      const idleSeconds = Math.round((now - lastActivity) / 1000);
      const runtimeSeconds = Math.round(((run.endedAt ?? now) - startedAt) / 1000);

      return jsonResult({
        status,
        sessionKey,
        runId: run.runId,
        label: run.label,
        task: run.task.length > 100 ? `${run.task.slice(0, 100)}…` : run.task,
        lastActivity: new Date(lastActivity).toISOString(),
        idleSeconds: status === "running" || status === "idle" ? idleSeconds : undefined,
        runtimeSeconds,
        model: run.model,
        outcome: run.outcome,
      });
    },
  };
}
