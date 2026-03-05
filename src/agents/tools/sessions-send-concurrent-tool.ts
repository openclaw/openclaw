import crypto from "node:crypto";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsSendConcurrentTargetSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

const SessionsSendConcurrentToolSchema = Type.Object({
  targets: Type.Array(SessionsSendConcurrentTargetSchema, { minItems: 1, maxItems: 20 }),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

type ConcurrentTarget = {
  sessionKey?: string;
  label?: string;
  agentId?: string;
  message: string;
  timeoutSeconds?: number;
};

type ConcurrentResult = {
  sessionKey: string;
  displayKey: string;
  status: "ok" | "error" | "timeout" | "forbidden" | "accepted";
  reply?: string;
  error?: string;
  runId: string;
  completedAt: number;
  delivery?: { status: string; mode: string };
};

type ConcurrentProgress = {
  runId?: string;
  status: "started" | "progress" | "completed";
  total: number;
  completed: number;
  latestResult?: ConcurrentResult;
};

export function createSessionsSendConcurrentTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    name: "sessions_send_concurrent",
    description:
      "Send messages to multiple agent sessions concurrently (1-20 targets). Each target can be identified by sessionKey, label, or agentId. Returns results as they complete with streaming progress updates.",
    label: "Concurrent Session Messaging",
    parameters: SessionsSendConcurrentToolSchema,
    execute: async (
      _toolCallId: string,
      args: unknown,
      _signal: AbortSignal | undefined,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ) => {
      const params = args as Record<string, unknown>;

      const targetsParam = params.targets;
      if (!Array.isArray(targetsParam) || targetsParam.length === 0 || targetsParam.length > 20) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "targets must be an array with 1-20 items",
        });
      }

      const globalTimeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 30;

      const targets: ConcurrentTarget[] = [];
      for (const [index, target] of targetsParam.entries()) {
        if (!target || typeof target !== "object") {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `target[${index}] must be an object`,
          });
        }
        const targetRecord = target as Record<string, unknown>;
        const message = readStringParam(targetRecord, "message", { required: true });
        targets.push({
          sessionKey: readStringParam(targetRecord, "sessionKey"),
          label: readStringParam(targetRecord, "label")?.trim() || undefined,
          agentId: readStringParam(targetRecord, "agentId")?.trim() || undefined,
          message,
          timeoutSeconds:
            typeof targetRecord.timeoutSeconds === "number" &&
            Number.isFinite(targetRecord.timeoutSeconds)
              ? Math.max(0, Math.floor(targetRecord.timeoutSeconds))
              : globalTimeoutSeconds,
        });
      }

      const totalTargets = targets.length;
      const runId = crypto.randomUUID();
      if (onUpdate) {
        onUpdate({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  runId,
                  status: "started",
                  total: totalTargets,
                  completed: 0,
                } as ConcurrentProgress,
                null,
                2,
              ),
            },
          ],
          details: {
            runId,
            status: "started",
            total: totalTargets,
            completed: 0,
          } as ConcurrentProgress,
        });
      }

      const results: ConcurrentResult[] = [];
      let completedCount = 0;

      const sendPromises = targets.map(async (target, index) => {
        const targetRunId = crypto.randomUUID();

        try {
          let sessionKey = target.sessionKey;
          if (!sessionKey && target.label) {
            const resolveParams: Record<string, unknown> = {
              label: target.label,
              ...(target.agentId ? { agentId: normalizeAgentId(target.agentId) } : {}),
            };

            try {
              const resolved = await callGateway<{ key: string }>({
                method: "sessions.resolve",
                params: resolveParams,
                timeoutMs: 10_000,
              });
              sessionKey = typeof resolved?.key === "string" ? resolved.key.trim() : "";
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (opts?.sandboxed) {
                const result: ConcurrentResult = {
                  sessionKey: target.sessionKey || target.label || `target-${index}`,
                  displayKey: target.sessionKey || target.label || `target-${index}`,
                  status: "forbidden",
                  error: "Session not visible from this sandboxed agent session.",
                  runId: targetRunId,
                  completedAt: Date.now(),
                };
                return result;
              }
              const result: ConcurrentResult = {
                sessionKey: target.sessionKey || target.label || `target-${index}`,
                displayKey: target.sessionKey || target.label || `target-${index}`,
                status: "error",
                error: msg || `No session found with label: ${target.label}`,
                runId: targetRunId,
                completedAt: Date.now(),
              };
              return result;
            }
          }

          if (!sessionKey) {
            const result: ConcurrentResult = {
              sessionKey: target.sessionKey || target.label || `target-${index}`,
              displayKey: target.sessionKey || target.label || `target-${index}`,
              status: "error",
              error: "Session not found",
              runId: targetRunId,
              completedAt: Date.now(),
            };
            return result;
          }

          const idempotencyKey = crypto.randomUUID();
          const sendParams = {
            message: target.message,
            sessionKey,
            idempotencyKey,
            deliver: false,
            channel: INTERNAL_MESSAGE_CHANNEL,
            lane: AGENT_LANE_NESTED,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: opts?.agentSessionKey,
              sourceChannel: opts?.agentChannel,
              sourceTool: "sessions_send_concurrent",
            },
          };

          const timeoutMs = (target.timeoutSeconds ?? globalTimeoutSeconds) * 1000;
          const response = await callGateway<{ runId: string }>({
            method: "agent",
            params: sendParams,
            timeoutMs,
          });

          const agentRunId =
            typeof response?.runId === "string" && response.runId
              ? response.runId
              : crypto.randomUUID();

          let waitStatus: "ok" | "error" | "timeout" | "forbidden" = "ok";
          let waitError: string | undefined;
          let reply: string | undefined;

          try {
            const wait = await callGateway<{ status?: string; error?: string }>({
              method: "agent.wait",
              params: {
                runId: agentRunId,
                timeoutMs,
              },
              timeoutMs: timeoutMs + 2000,
            });
            waitStatus =
              typeof wait?.status === "string"
                ? (wait.status as "ok" | "error" | "timeout" | "forbidden")
                : "ok";
            waitError = typeof wait?.error === "string" ? wait.error : undefined;
          } catch (err) {
            const messageText =
              err instanceof Error ? err.message : typeof err === "string" ? err : "error";
            waitStatus = messageText.includes("gateway timeout") ? "timeout" : "error";
            waitError = messageText;
          }

          if (waitStatus === "ok") {
            try {
              const history = await callGateway<{ messages: Array<unknown> }>({
                method: "chat.history",
                params: { sessionKey, limit: 50 },
              });
              const filtered = Array.isArray(history?.messages) ? history.messages : [];
              const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
              reply =
                typeof last === "object" && last !== null && "content" in last
                  ? String((last as { content: unknown }).content)
                  : undefined;
            } catch {
              // ignore
            }
          }

          const result: ConcurrentResult = {
            sessionKey,
            displayKey: sessionKey,
            status: waitStatus,
            reply,
            error: waitError,
            runId: agentRunId,
            completedAt: Date.now(),
            delivery: { status: "pending", mode: "announce" },
          };

          return result;
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          const result: ConcurrentResult = {
            sessionKey: target.sessionKey || target.label || `target-${index}`,
            displayKey: target.sessionKey || target.label || `target-${index}`,
            status: "error",
            error: messageText,
            runId: targetRunId,
            completedAt: Date.now(),
          };
          return result;
        }
      });

      const settledResults = await Promise.allSettled(sendPromises);

      for (const settled of settledResults) {
        if (settled.status === "fulfilled") {
          results.push(settled.value);
          completedCount++;

          if (onUpdate) {
            onUpdate({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "progress",
                      total: totalTargets,
                      completed: completedCount,
                      latestResult: settled.value,
                    } as ConcurrentProgress,
                    null,
                    2,
                  ),
                },
              ],
              details: {
                status: "progress",
                total: totalTargets,
                completed: completedCount,
                latestResult: settled.value,
              } as ConcurrentProgress,
            });
          }
        } else {
          // 处理 rejected promise
          const errorResult: ConcurrentResult = {
            sessionKey: `unknown-${results.length}`,
            displayKey: `unknown-${results.length}`,
            status: "error",
            error:
              settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
            runId: crypto.randomUUID(),
            completedAt: Date.now(),
          };
          results.push(errorResult);
          completedCount++;
        }
      }

      if (onUpdate) {
        onUpdate({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "completed",
                  total: totalTargets,
                  completed: completedCount,
                } as ConcurrentProgress,
                null,
                2,
              ),
            },
          ],
          details: {
            status: "completed",
            total: totalTargets,
            completed: completedCount,
          } as ConcurrentProgress,
        });
      }

      const successCount = results.filter((r) => r.status === "ok").length;
      const errorCount = results.filter((r) => r.status === "error").length;
      const timeoutCount = results.filter((r) => r.status === "timeout").length;
      const forbiddenCount = results.filter((r) => r.status === "forbidden").length;

      return jsonResult({
        runId,
        status: "completed",
        total: totalTargets,
        completed: completedCount,
        success: successCount,
        error: errorCount,
        timeout: timeoutCount,
        forbidden: forbiddenCount,
        results,
      });
    },
  };
}
