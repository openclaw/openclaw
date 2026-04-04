import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  isValidAgentId,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
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
  extractAssistantText,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
  stripToolMessages,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext, resolvePingPongTurns } from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 64,
      description:
        "Agent id to target. When used without sessionKey/label, OpenClaw sends to the most recent visible session for that agent.",
    }),
  ),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

type GatewayCaller = typeof callGateway;
const SESSIONS_SEND_REPLY_HISTORY_LIMIT = 50;

function resolveLatestAssistantReplySnapshot(messages: unknown[]): {
  text?: string;
  fingerprint?: string;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = extractAssistantText(message);
    if (!text) {
      continue;
    }
    let fingerprint: string | undefined;
    try {
      fingerprint = JSON.stringify(message);
    } catch {
      fingerprint = text;
    }
    return { text, fingerprint };
  }
  return {};
}

async function startAgentRun(params: {
  callGateway: GatewayCaller;
  runId: string;
  sendParams: Record<string, unknown>;
  sessionKey: string;
}): Promise<{ ok: true; runId: string } | { ok: false; result: ReturnType<typeof jsonResult> }> {
  try {
    const response = await params.callGateway<{ runId: string }>({
      method: "agent",
      params: params.sendParams,
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
    };
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      ok: false,
      result: jsonResult({
        runId: params.runId,
        status: "error",
        error: messageText,
        sessionKey: params.sessionKey,
      }),
    };
  }
}

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    description:
      "Send a message into another session. Use sessionKey, label, or agentId to identify the target.",
    parameters: SessionsSendToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const message = readStringParam(params, "message", { required: true });
      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = readStringParam(params, "label")?.trim() || undefined;
      const labelAgentIdParam = readStringParam(params, "agentId")?.trim() || undefined;
      const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
      const requestedAgentIdFromParam = labelAgentIdParam
        ? normalizeAgentId(labelAgentIdParam)
        : undefined;

      const buildRequestedAgentDeniedResult = (requestedAgentId?: string) => {
        if (!requestedAgentId) {
          return null;
        }
        if (restrictToSpawned && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send agent lookup is limited to this agent",
          });
        }
        if (requestedAgentId !== requesterAgentId) {
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
        return null;
      };

      const resolveLatestSessionKeyForAgent = async (
        requestedAgentId: string | undefined,
        missingError: string,
      ): Promise<{ key: string } | { result: ReturnType<typeof jsonResult> }> => {
        if (!requestedAgentId) {
          return { key: "" };
        }
        const deniedResult = buildRequestedAgentDeniedResult(requestedAgentId);
        if (deniedResult) {
          return { result: deniedResult };
        }
        try {
          const listed = await gatewayCall<{
            sessions?: Array<{
              key?: string;
            }>;
          }>({
            method: "sessions.list",
            params: {
              limit: 50,
              includeGlobal: false,
              includeUnknown: false,
              agentId: requestedAgentId,
              ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
            },
            timeoutMs: 10_000,
          });
          const sessions = Array.isArray(listed?.sessions) ? listed.sessions : [];
          for (const entry of sessions) {
            const key = typeof entry?.key === "string" ? entry.key.trim() : "";
            if (key) {
              return { key };
            }
          }
        } catch (err) {
          const messageText = err instanceof Error ? err.message : String(err);
          if (restrictToSpawned) {
            return {
              result: jsonResult({
                runId: crypto.randomUUID(),
                status: "forbidden",
                error: "Session not visible from this sandboxed agent session.",
              }),
            };
          }
          return {
            result: jsonResult({
              runId: crypto.randomUUID(),
              status: "error",
              error: messageText || missingError,
            }),
          };
        }
        return {
          result: jsonResult({
            runId: crypto.randomUUID(),
            status: restrictToSpawned ? "forbidden" : "error",
            error: restrictToSpawned
              ? "Session not visible from this sandboxed agent session."
              : missingError,
          }),
        };
      };

      if (sessionKeyParam && labelParam) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Provide either sessionKey or label (not both).",
        });
      }

      let sessionKey = sessionKeyParam;
      if (!sessionKey && labelParam) {
        const requestedAgentId = requestedAgentIdFromParam;
        const deniedResult = buildRequestedAgentDeniedResult(requestedAgentId);
        if (deniedResult) {
          return deniedResult;
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey = "";
        let resolveErrorMessage = "";
        try {
          const resolved = await gatewayCall<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = typeof resolved?.key === "string" ? resolved.key.trim() : "";
        } catch (err) {
          resolveErrorMessage = err instanceof Error ? err.message : String(err);
        }

        if (!resolvedKey) {
          const fallbackAgentId =
            requestedAgentId ??
            (isValidAgentId(labelParam) ? normalizeAgentId(labelParam) : undefined);
          const fallback = await resolveLatestSessionKeyForAgent(
            fallbackAgentId,
            `No session found with label: ${labelParam}`,
          );
          if ("result" in fallback) {
            return fallback.result;
          }
          resolvedKey = fallback.key;
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
            error: resolveErrorMessage || `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey && requestedAgentIdFromParam) {
        const fallback = await resolveLatestSessionKeyForAgent(
          requestedAgentIdFromParam,
          `No session found for agentId: ${requestedAgentIdFromParam}`,
        );
        if ("result" in fallback) {
          return fallback.result;
        }
        sessionKey = fallback.key;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey, label, or agentId is required",
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
      const maxPingPongTurns = resolvePingPongTurns(cfg);
      const delivery = { status: "pending", mode: "announce" as const };
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
        });
      };

      if (timeoutSeconds === 0) {
        const start = await startAgentRun({
          callGateway: gatewayCall,
          runId,
          sendParams,
          sessionKey: displayKey,
        });
        if (!start.ok) {
          return start.result;
        }
        runId = start.runId;
        startA2AFlow(undefined, runId);
        return jsonResult({
          runId,
          status: "accepted",
          sessionKey: displayKey,
          delivery,
        });
      }

      const start = await startAgentRun({
        callGateway: gatewayCall,
        runId,
        sendParams,
        sessionKey: displayKey,
      });
      if (!start.ok) {
        return start.result;
      }
      runId = start.runId;

      const historyBefore = await gatewayCall<{ messages: Array<unknown> }>({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT },
      });
      const baselineReply = resolveLatestAssistantReplySnapshot(
        stripToolMessages(Array.isArray(historyBefore?.messages) ? historyBefore.messages : []),
      );

      let waitStatus: string | undefined;
      let waitError: string | undefined;
      try {
        const wait = await gatewayCall<{ status?: string; error?: string }>({
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
        });
      }

      if (waitStatus === "timeout") {
        return jsonResult({
          runId,
          status: "timeout",
          error: waitError,
          sessionKey: displayKey,
        });
      }
      if (waitStatus === "error") {
        return jsonResult({
          runId,
          status: "error",
          error: waitError ?? "agent error",
          sessionKey: displayKey,
        });
      }

      const history = await gatewayCall<{ messages: Array<unknown> }>({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT },
      });
      const latestReply = resolveLatestAssistantReplySnapshot(
        stripToolMessages(Array.isArray(history?.messages) ? history.messages : []),
      );
      const reply =
        latestReply.text && latestReply.fingerprint !== baselineReply.fingerprint
          ? latestReply.text
          : undefined;
      startA2AFlow(reply ?? undefined);

      return jsonResult({
        runId,
        status: "ok",
        reply,
        sessionKey: displayKey,
        delivery,
      });
    },
  };
}
