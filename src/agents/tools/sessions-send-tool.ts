import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../../sessions/input-provenance.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  extractAssistantText,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSandboxedSessionToolContext,
  resolveVisibleSessionReference,
  stripToolMessages,
} from "./sessions-helpers.js";
import {
  buildAgentToAgentIngressEchoText,
  buildAgentToAgentMessageContext,
  resolveIngressEchoPolicy,
  resolvePingPongTurns,
  resolveRelayPolicy,
} from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    description:
      "Send a message into another session. Use sessionKey or label to identify the target.",
    parameters: SessionsSendToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message", { required: true });
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

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = readStringParam(params, "label")?.trim() || undefined;
      const labelAgentIdParam = readStringParam(params, "agentId")?.trim() || undefined;
      if (sessionKeyParam && labelParam) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Provide either sessionKey or label (not both).",
        });
      }

      let sessionKey = sessionKeyParam;
      if (!sessionKey && labelParam) {
        const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send label lookup is limited to this agent",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
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
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: msg || `No session found with label: ${labelParam}`,
          });
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }
      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: visibleSession.displayKey,
        });
      }
      // Normalize sessionKey/sessionId input into a canonical session key.
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 30;
      const timeoutMs = timeoutSeconds * 1000;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: access.error,
          sessionKey: displayKey,
        });
      }

      const ingressEchoPolicy = resolveIngressEchoPolicy(cfg);
      let ingressEcho: Record<string, unknown> = {
        status: ingressEchoPolicy.enabled ? "not_applicable" : "disabled",
      };
      if (ingressEchoPolicy.enabled) {
        const announceTarget = await resolveAnnounceTarget({
          sessionKey: resolvedKey,
          displayKey,
        });
        if (announceTarget) {
          const echoMessage = buildAgentToAgentIngressEchoText({
            requesterSessionKey: opts?.agentSessionKey,
            requesterChannel: opts?.agentChannel,
            targetSessionKey: displayKey,
            message,
          });
          try {
            const response = await callGateway({
              method: "send",
              params: {
                to: announceTarget.to,
                message: echoMessage,
                channel: announceTarget.channel,
                accountId: announceTarget.accountId,
                threadId: announceTarget.threadId,
                idempotencyKey: crypto.randomUUID(),
              },
              timeoutMs: 10_000,
            });
            ingressEcho = {
              status: "sent",
              channel: announceTarget.channel,
              to: announceTarget.to,
              accountId: announceTarget.accountId,
              threadId:
                (typeof response?.threadId === "string" ? response.threadId : undefined) ??
                announceTarget.threadId,
              messageId:
                typeof response?.messageId === "string"
                  ? response.messageId
                  : typeof response?.id === "string"
                    ? response.id
                    : undefined,
            };
          } catch (err) {
            const errorText =
              err instanceof Error ? err.message : typeof err === "string" ? err : "error";
            ingressEcho = {
              status: ingressEchoPolicy.requireDelivery ? "blocked" : "failed",
              channel: announceTarget.channel,
              to: announceTarget.to,
              accountId: announceTarget.accountId,
              threadId: announceTarget.threadId,
              error: errorText,
            };
            if (ingressEchoPolicy.requireDelivery) {
              return jsonResult({
                runId: crypto.randomUUID(),
                status: "error",
                error: errorText,
                sessionKey: displayKey,
                ingressEcho,
              });
            }
          }
        } else if (ingressEchoPolicy.requireDelivery) {
          ingressEcho = { status: "blocked", error: "No ingress echo target could be resolved." };
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: "No ingress echo target could be resolved.",
            sessionKey: displayKey,
            ingressEcho,
          });
        }
      }

      const allowNestedSessionsSend =
        cfg.session?.agentToAgent?.guard?.allowNestedSessionsSend === true;
      if (!allowNestedSessionsSend && opts?.agentSessionKey) {
        try {
          const currentHistory = await callGateway<{ messages?: Array<Record<string, unknown>> }>({
            method: "chat.history",
            params: { sessionKey: opts.agentSessionKey, limit: 20 },
            timeoutMs: 10_000,
          });
          const messages = Array.isArray(currentHistory?.messages) ? currentHistory.messages : [];
          const latestUser = [...messages].toReversed().find((entry) => entry?.role === "user");
          const provenance = latestUser?.provenance as Record<string, unknown> | undefined;
          if (
            hasInterSessionUserProvenance(latestUser as { role?: unknown; provenance?: unknown }) &&
            provenance?.sourceTool === "sessions_send"
          ) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Nested sessions_send relay blocked by session.agentToAgent.guard.allowNestedSessionsSend=false.",
              sessionKey: displayKey,
              ingressEcho,
            });
          }
        } catch {
          // Best effort guard; if current session history is unavailable, preserve prior behavior.
        }
      }

      const agentMessageContext = buildAgentToAgentMessageContext({
        requesterSessionKey: opts?.agentSessionKey,
        requesterChannel: opts?.agentChannel,
        targetSessionKey: displayKey,
      });
      const sendParams = {
        message,
        sessionKey: resolvedKey,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_NESTED,
        extraSystemPrompt: agentMessageContext,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: opts?.agentSessionKey,
          sourceChannel: opts?.agentChannel,
          sourceTool: "sessions_send",
        },
      };
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterChannel = opts?.agentChannel;
      const relayPolicy = resolveRelayPolicy(cfg);
      const requesterAgentId = requesterSessionKey
        ? (resolveAgentIdFromSessionKey(requesterSessionKey) ?? "requester")
        : "requester";
      const targetAgentId = resolveAgentIdFromSessionKey(resolvedKey) ?? "target";
      const sourceRelayTarget =
        requesterSessionKey && requesterSessionKey !== resolvedKey
          ? await resolveAnnounceTarget({
              sessionKey: requesterSessionKey,
              displayKey: requesterSessionKey,
            })
          : null;
      const targetRelayTarget = await resolveAnnounceTarget({
        sessionKey: resolvedKey,
        displayKey,
      });
      const maxPingPongTurns = resolvePingPongTurns(cfg);
      const delivery = { status: "pending", mode: "announce" as const };
      const relay = {
        status: relayPolicy.enabled ? "pending" : "disabled",
        mode: relayPolicy.mode,
        mirrorTurns: relayPolicy.mirrorTurns,
      };
      const startA2AFlow = (roundOneReply?: string, waitRunId?: string) => {
        void runSessionsSendA2AFlow({
          targetSessionKey: resolvedKey,
          displayKey,
          message,
          announceTimeoutMs,
          maxPingPongTurns,
          requesterSessionKey,
          requesterChannel,
          roundOneReply,
          waitRunId,
          relayPolicy,
          sourceRelayTarget,
          targetRelayTarget,
          requesterAgentId,
          targetAgentId,
        });
      };

      if (timeoutSeconds === 0) {
        try {
          const response = await callGateway<{ runId: string }>({
            method: "agent",
            params: sendParams,
            timeoutMs: 10_000,
          });
          if (typeof response?.runId === "string" && response.runId) {
            runId = response.runId;
          }
          startA2AFlow(undefined, runId);
          return jsonResult({
            runId,
            status: "accepted",
            sessionKey: displayKey,
            delivery,
            ingressEcho,
            relay,
          });
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          return jsonResult({
            runId,
            status: "error",
            error: messageText,
            sessionKey: displayKey,
            ingressEcho,
          });
        }
      }

      try {
        const response = await callGateway<{ runId: string }>({
          method: "agent",
          params: sendParams,
          timeoutMs: 10_000,
        });
        if (typeof response?.runId === "string" && response.runId) {
          runId = response.runId;
        }
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return jsonResult({
          runId,
          status: "error",
          error: messageText,
          sessionKey: displayKey,
          ingressEcho,
        });
      }

      let waitStatus: string | undefined;
      let waitError: string | undefined;
      try {
        const wait = await callGateway<{ status?: string; error?: string }>({
          method: "agent.wait",
          params: {
            runId,
            timeoutMs,
          },
          timeoutMs: timeoutMs + 2000,
        });
        waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
        waitError = typeof wait?.error === "string" ? wait.error : undefined;
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return jsonResult({
          runId,
          status: messageText.includes("gateway timeout") ? "timeout" : "error",
          error: messageText,
          sessionKey: displayKey,
          ingressEcho,
        });
      }

      if (waitStatus === "timeout") {
        return jsonResult({
          runId,
          status: "timeout",
          error: waitError,
          sessionKey: displayKey,
          ingressEcho,
        });
      }
      if (waitStatus === "error") {
        return jsonResult({
          runId,
          status: "error",
          error: waitError ?? "agent error",
          sessionKey: displayKey,
          ingressEcho,
        });
      }

      const history = await callGateway<{ messages: Array<unknown> }>({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit: 50 },
      });
      const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
      const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
      const reply = last ? extractAssistantText(last) : undefined;
      startA2AFlow(reply ?? undefined);

      return jsonResult({
        runId,
        status: "ok",
        reply,
        sessionKey: displayKey,
        delivery,
        ingressEcho,
        relay,
      });
    },
  };
}
