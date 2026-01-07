import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  buildSubagentSystemPrompt,
  runSubagentAnnounceFlow,
} from "../subagent-announce.js";
import {
  beginSubagentAnnounce,
  registerSubagentRun,
} from "../subagent-registry.js";
import { readLatestAssistantReply } from "./agent-step.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  cleanup: Type.Optional(
    Type.Union([Type.Literal("delete"), Type.Literal("keep")]),
  ),
});

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentProvider?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a background sub-agent run in an isolated session and announce the result back to the requester chat.",
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const model = readStringParam(params, "model");
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete"
          ? (params.cleanup as "keep" | "delete")
          : "keep";
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" &&
        Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 0;
      const timeoutMs = timeoutSeconds * 1000;
      let modelWarning: string | undefined;
      let modelApplied = false;

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey;
      if (
        typeof requesterSessionKey === "string" &&
        isSubagentSessionKey(requesterSessionKey)
      ) {
        return jsonResult({
          status: "forbidden",
          error: "sessions_spawn is not allowed from sub-agent sessions",
        });
      }
      const requesterInternalKey = requesterSessionKey
        ? resolveInternalSessionKey({
            key: requesterSessionKey,
            alias,
            mainKey,
          })
        : alias;
      const requesterDisplayKey = resolveDisplaySessionKey({
        key: requesterInternalKey,
        alias,
        mainKey,
      });

      const requesterAgentId = normalizeAgentId(
        parseAgentSessionKey(requesterInternalKey)?.agentId,
      );
      const childSessionKey = `agent:${requesterAgentId}:subagent:${crypto.randomUUID()}`;
      if (opts?.sandboxed === true) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: childSessionKey, spawnedBy: requesterInternalKey },
            timeoutMs: 10_000,
          });
        } catch {
          // best-effort; scoping relies on this metadata but spawning still works without it
        }
      }
      if (model) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: childSessionKey, model },
            timeoutMs: 10_000,
          });
          modelApplied = true;
        } catch (err) {
          const messageText =
            err instanceof Error
              ? err.message
              : typeof err === "string"
                ? err
                : "error";
          const recoverable =
            messageText.includes("invalid model") ||
            messageText.includes("model not allowed");
          if (!recoverable) {
            return jsonResult({
              status: "error",
              error: messageText,
              childSessionKey,
            });
          }
          modelWarning = messageText;
        }
      }
      const childSystemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey,
        requesterProvider: opts?.agentProvider,
        childSessionKey,
        label: label || undefined,
      });

      const childIdem = crypto.randomUUID();
      let childRunId: string = childIdem;
      try {
        const response = (await callGateway({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            idempotencyKey: childIdem,
            deliver: false,
            lane: "subagent",
            extraSystemPrompt: childSystemPrompt,
          },
          timeoutMs: 10_000,
        })) as { runId?: string };
        if (typeof response?.runId === "string" && response.runId) {
          childRunId = response.runId;
        }
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "error";
        return jsonResult({
          status: "error",
          error: messageText,
          childSessionKey,
          runId: childRunId,
        });
      }

      registerSubagentRun({
        runId: childRunId,
        childSessionKey,
        requesterSessionKey: requesterInternalKey,
        requesterProvider: opts?.agentProvider,
        requesterDisplayKey,
        task,
        cleanup,
      });

      if (timeoutSeconds === 0) {
        return jsonResult({
          status: "accepted",
          childSessionKey,
          runId: childRunId,
          modelApplied: model ? modelApplied : undefined,
          warning: modelWarning,
        });
      }

      let waitStatus: string | undefined;
      let waitError: string | undefined;
      let waitStartedAt: number | undefined;
      let waitEndedAt: number | undefined;
      try {
        const wait = (await callGateway({
          method: "agent.wait",
          params: {
            runId: childRunId,
            timeoutMs,
          },
          timeoutMs: timeoutMs + 2000,
        })) as {
          status?: string;
          error?: string;
          startedAt?: number;
          endedAt?: number;
        };
        waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
        waitError = typeof wait?.error === "string" ? wait.error : undefined;
        waitStartedAt =
          typeof wait?.startedAt === "number" ? wait.startedAt : undefined;
        waitEndedAt =
          typeof wait?.endedAt === "number" ? wait.endedAt : undefined;
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "error";
        return jsonResult({
          status: messageText.includes("gateway timeout") ? "timeout" : "error",
          error: messageText,
          childSessionKey,
          runId: childRunId,
        });
      }

      if (waitStatus === "timeout") {
        try {
          await callGateway({
            method: "chat.abort",
            params: { sessionKey: childSessionKey, runId: childRunId },
            timeoutMs: 5_000,
          });
        } catch {
          // best-effort
        }
        return jsonResult({
          status: "timeout",
          error: waitError,
          childSessionKey,
          runId: childRunId,
          modelApplied: model ? modelApplied : undefined,
          warning: modelWarning,
        });
      }
      if (waitStatus === "error") {
        return jsonResult({
          status: "error",
          error: waitError ?? "agent error",
          childSessionKey,
          runId: childRunId,
          modelApplied: model ? modelApplied : undefined,
          warning: modelWarning,
        });
      }

      const replyText = await readLatestAssistantReply({
        sessionKey: childSessionKey,
      });
      if (beginSubagentAnnounce(childRunId)) {
        void runSubagentAnnounceFlow({
          childSessionKey,
          childRunId,
          requesterSessionKey: requesterInternalKey,
          requesterProvider: opts?.agentProvider,
          requesterDisplayKey,
          task,
          timeoutMs: 30_000,
          cleanup,
          roundOneReply: replyText,
          startedAt: waitStartedAt,
          endedAt: waitEndedAt,
        });
      }

      return jsonResult({
        status: "ok",
        childSessionKey,
        runId: childRunId,
        reply: replyText,
        modelApplied: model ? modelApplied : undefined,
        warning: modelWarning,
      });
    },
  };
}
