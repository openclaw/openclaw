import crypto from "node:crypto";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSandboxedSessionToolContext,
  resolveVisibleSessionReference,
  extractAssistantText,
  stripToolMessages,
} from "./sessions-helpers.js";
import { runConcurrentA2AFlowForTarget } from "./sessions-send-concurrent-a2a.js";
import { buildAgentToAgentMessageContext, resolvePingPongTurns } from "./sessions-send-helpers.js";

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
  delivery?: {
    status: "pending" | "completed";
    mode: "announce";
  };
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
      const cfg = loadConfig();
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

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

      // Resolve maxPingPongTurns from config (same as sessions_send)
      const maxPingPongTurns = resolvePingPongTurns(cfg);

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
          let displayKey = target.sessionKey || target.label || `target-${index}`;

          if (!sessionKey && target.label) {
            const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
            const requestedAgentId = target.agentId ? normalizeAgentId(target.agentId) : undefined;

            if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
              const result: ConcurrentResult = {
                sessionKey: target.sessionKey || target.label || `target-${index}`,
                displayKey,
                status: "forbidden",
                error: "Sandboxed sessions_send label lookup is limited to this agent",
                runId: targetRunId,
                completedAt: Date.now(),
              };
              return result;
            }

            if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
              if (!a2aPolicy.enabled) {
                const result: ConcurrentResult = {
                  sessionKey: target.sessionKey || target.label || `target-${index}`,
                  displayKey,
                  status: "forbidden",
                  error:
                    "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
                  runId: targetRunId,
                  completedAt: Date.now(),
                };
                return result;
              }
              if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
                const result: ConcurrentResult = {
                  sessionKey: target.sessionKey || target.label || `target-${index}`,
                  displayKey,
                  status: "forbidden",
                  error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
                  runId: targetRunId,
                  completedAt: Date.now(),
                };
                return result;
              }
            }

            const resolveParams: Record<string, unknown> = {
              label: target.label,
              ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
              ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
            };
            let resolvedKey = "";
            try {
              const resolved = await callGateway<{ key: string }>({
                method: "sessions.resolve",
                params: resolveParams,
                timeoutMs: 10_000,
              });
              resolvedKey = typeof resolved?.key === "string" ? resolved.key.trim() : "";
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (restrictToSpawned) {
                const result: ConcurrentResult = {
                  sessionKey: target.sessionKey || target.label || `target-${index}`,
                  displayKey,
                  status: "forbidden",
                  error: "Session not visible from this sandboxed agent session.",
                  runId: targetRunId,
                  completedAt: Date.now(),
                };
                return result;
              }
              const result: ConcurrentResult = {
                sessionKey: target.sessionKey || target.label || `target-${index}`,
                displayKey,
                status: "error",
                error: msg || `No session found with label: ${target.label}`,
                runId: targetRunId,
                completedAt: Date.now(),
              };
              return result;
            }

            if (!resolvedKey) {
              if (restrictToSpawned) {
                const result: ConcurrentResult = {
                  sessionKey: target.sessionKey || target.label || `target-${index}`,
                  displayKey,
                  status: "forbidden",
                  error: "Session not visible from this sandboxed agent session.",
                  runId: targetRunId,
                  completedAt: Date.now(),
                };
                return result;
              }
              const result: ConcurrentResult = {
                sessionKey: target.sessionKey || target.label || `target-${index}`,
                displayKey,
                status: "error",
                error: `No session found with label: ${target.label}`,
                runId: targetRunId,
                completedAt: Date.now(),
              };
              return result;
            }
            sessionKey = resolvedKey;
          }

          if (!sessionKey) {
            const result: ConcurrentResult = {
              sessionKey: target.sessionKey || target.label || `target-${index}`,
              displayKey,
              status: "error",
              error: "Either sessionKey or label is required",
              runId: targetRunId,
              completedAt: Date.now(),
            };
            return result;
          }

          const resolvedSession = await resolveSessionReference({
            sessionKey,
            alias,
            mainKey,
            requesterInternalKey: effectiveRequesterKey,
            restrictToSpawned,
          });
          if (!resolvedSession.ok) {
            const result: ConcurrentResult = {
              sessionKey: target.sessionKey || target.label || `target-${index}`,
              displayKey,
              status: resolvedSession.status,
              error: resolvedSession.error,
              runId: targetRunId,
              completedAt: Date.now(),
            };
            return result;
          }

          const visibleSession = await resolveVisibleSessionReference({
            resolvedSession,
            requesterSessionKey: effectiveRequesterKey,
            restrictToSpawned,
            visibilitySessionKey: sessionKey,
          });
          if (!visibleSession.ok) {
            const result: ConcurrentResult = {
              sessionKey: target.sessionKey || target.label || `target-${index}`,
              displayKey: visibleSession.displayKey,
              status: visibleSession.status,
              error: visibleSession.error,
              runId: targetRunId,
              completedAt: Date.now(),
            };
            return result;
          }

          const resolvedKey = visibleSession.key;
          displayKey = visibleSession.displayKey;

          const visibilityGuard = await createSessionVisibilityGuard({
            action: "send",
            requesterSessionKey: effectiveRequesterKey,
            visibility: sessionVisibility,
            a2aPolicy,
          });
          const access = visibilityGuard.check(resolvedKey);
          if (!access.allowed) {
            const result: ConcurrentResult = {
              sessionKey: target.sessionKey || target.label || `target-${index}`,
              displayKey,
              status: access.status,
              error: access.error,
              runId: targetRunId,
              completedAt: Date.now(),
            };
            return result;
          }

          const idempotencyKey = crypto.randomUUID();
          const sendParams = {
            message: target.message,
            sessionKey: resolvedKey,
            idempotencyKey,
            deliver: false,
            channel: INTERNAL_MESSAGE_CHANNEL,
            lane: AGENT_LANE_NESTED,
            extraSystemPrompt: buildAgentToAgentMessageContext({
              requesterSessionKey: opts?.agentSessionKey,
              requesterChannel: opts?.agentChannel,
              targetSessionKey: displayKey,
            }),
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: opts?.agentSessionKey,
              sourceChannel: opts?.agentChannel,
              sourceTool: "sessions_send_concurrent",
            },
          };

          const targetTimeoutSeconds = target.timeoutSeconds ?? globalTimeoutSeconds;
          const isFireAndForget = targetTimeoutSeconds === 0;

          // Calculate announceTimeoutMs (same as sessions_send)
          const announceTimeoutMs =
            targetTimeoutSeconds === 0 ? 30_000 : targetTimeoutSeconds * 1000;

          let result: ConcurrentResult;
          const delivery = { status: "pending" as const, mode: "announce" as const };

          if (isFireAndForget) {
            // ========== Fire-and-forget mode (same as sessions_send) ==========
            let agentRunId: string = idempotencyKey;
            try {
              const response = await callGateway<{ runId: string }>({
                method: "agent",
                params: sendParams,
                timeoutMs: 10_000,
              });
              if (typeof response?.runId === "string" && response.runId) {
                agentRunId = response.runId;
              }

              // Start async A2A flow (same as sessions_send)
              // Note: A2A flow runs asynchronously and does not return responses to requester
              // to avoid duplicate responses. Ping-pong and announce are handled internally.
              void runConcurrentA2AFlowForTarget({
                targetSessionKey: resolvedKey,
                displayKey,
                originalMessage: target.message,
                requesterSessionKey: opts?.agentSessionKey,
                requesterChannel: opts?.agentChannel,
                primaryTimeoutMs: targetTimeoutSeconds * 1000,
                announceTimeoutMs,
                maxPingPongTurns,
                isFireAndForget: true,
                roundOneReply: undefined,
                waitRunId: agentRunId,
              });

              result = {
                sessionKey: resolvedKey,
                displayKey,
                status: "accepted",
                runId: agentRunId,
                completedAt: Date.now(),
                delivery,
              };
            } catch (err) {
              const messageText =
                err instanceof Error ? err.message : typeof err === "string" ? err : "error";
              result = {
                sessionKey: resolvedKey,
                displayKey,
                status: "error",
                error: messageText,
                runId: agentRunId,
                completedAt: Date.now(),
              };
            }
          } else {
            // ========== Wait mode (same as sessions_send) ==========
            const timeoutMs = targetTimeoutSeconds * 1000;

            // Send message
            let agentRunId: string = idempotencyKey;
            try {
              const response = await callGateway<{ runId: string }>({
                method: "agent",
                params: sendParams,
                timeoutMs: 10_000, // agent.run should return quickly with accepted status
              });
              if (typeof response?.runId === "string" && response.runId) {
                agentRunId = response.runId;
              }
            } catch (err) {
              const messageText =
                err instanceof Error ? err.message : typeof err === "string" ? err : "error";
              result = {
                sessionKey: resolvedKey,
                displayKey,
                status: "error",
                error: messageText,
                runId: agentRunId,
                completedAt: Date.now(),
              };
              return result;
            }

            // Wait for primary run completion
            let waitStatus: "ok" | "error" | "timeout" = "ok";
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
                  ? (wait.status as "ok" | "error" | "timeout")
                  : "ok";
              waitError = typeof wait?.error === "string" ? wait.error : undefined;
            } catch (err) {
              const messageText =
                err instanceof Error ? err.message : typeof err === "string" ? err : "error";
              waitStatus = messageText.includes("gateway timeout") ? "timeout" : "error";
              waitError = messageText;
            }

            if (waitStatus === "timeout") {
              result = {
                sessionKey: resolvedKey,
                displayKey,
                status: "timeout",
                error: waitError,
                runId: agentRunId,
                completedAt: Date.now(),
              };
              return result;
            }

            if (waitStatus === "error") {
              result = {
                sessionKey: resolvedKey,
                displayKey,
                status: "error",
                error: waitError ?? "agent error",
                runId: agentRunId,
                completedAt: Date.now(),
              };
              return result;
            }

            // Read primary run reply
            if (waitStatus === "ok") {
              try {
                const history = await callGateway<{ messages: Array<unknown> }>({
                  method: "chat.history",
                  params: { sessionKey: resolvedKey, limit: 50 },
                });
                const filtered = stripToolMessages(
                  Array.isArray(history?.messages) ? history.messages : [],
                );
                const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
                reply = extractAssistantText(last);
              } catch {
                // ignore
              }
            }

            result = {
              sessionKey: resolvedKey,
              displayKey,
              status: "ok",
              reply,
              runId: agentRunId,
              completedAt: Date.now(),
              delivery,
            };

            // Start A2A flow (same as sessions_send)
            // Note: A2A flow runs asynchronously and does not return responses to requester
            // to avoid duplicate responses. Ping-pong and announce are handled internally.
            void runConcurrentA2AFlowForTarget({
              targetSessionKey: resolvedKey,
              displayKey,
              originalMessage: target.message,
              requesterSessionKey: opts?.agentSessionKey,
              requesterChannel: opts?.agentChannel,
              primaryTimeoutMs: timeoutMs,
              announceTimeoutMs,
              maxPingPongTurns,
              isFireAndForget: false,
              roundOneReply: reply,
              waitRunId: agentRunId,
            });
          }

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

      // Wrap each promise to trigger onUpdate immediately on completion
      const wrappedPromises = sendPromises.map(async (promise) => {
        try {
          const result = await promise;
          results.push(result);
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
                      latestResult: result,
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
                latestResult: result,
              } as ConcurrentProgress,
            });
          }

          return result;
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          const errorResult: ConcurrentResult = {
            sessionKey: `unknown-${results.length}`,
            displayKey: `unknown-${results.length}`,
            status: "error",
            error: messageText,
            runId: crypto.randomUUID(),
            completedAt: Date.now(),
          };
          results.push(errorResult);
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
                      latestResult: errorResult,
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
                latestResult: errorResult,
              } as ConcurrentProgress,
            });
          }

          return errorResult;
        }
      });

      await Promise.allSettled(wrappedPromises);

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
