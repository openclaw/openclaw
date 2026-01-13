import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  extractAssistantText,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  stripToolMessages,
} from "./sessions-helpers.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentMessageContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
  resolvePingPongTurns,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(
    Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH }),
  ),
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
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const visibility =
        cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : undefined;
      const restrictToSpawned =
        opts?.sandboxed === true &&
        visibility === "spawned" &&
        requesterInternalKey &&
        !isSubagentSessionKey(requesterInternalKey);

      const routingA2A = cfg.tools?.agentToAgent;
      const a2aEnabled = routingA2A?.enabled === true;
      const allowPatterns = Array.isArray(routingA2A?.allow)
        ? routingA2A.allow
        : [];
      const matchesAllow = (agentId: string) => {
        if (allowPatterns.length === 0) return true;
        return allowPatterns.some((pattern) => {
          const raw = String(pattern ?? "").trim();
          if (!raw) return false;
          if (raw === "*") return true;
          if (!raw.includes("*")) return raw === agentId;
          const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`, "i");
          return re.test(agentId);
        });
      };

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = readStringParam(params, "label")?.trim() || undefined;
      const labelAgentIdParam =
        readStringParam(params, "agentId")?.trim() || undefined;
      if (sessionKeyParam && labelParam) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Provide either sessionKey or label (not both).",
        });
      }

      const listSessions = async (listParams: Record<string, unknown>) => {
        const result = (await callGateway({
          method: "sessions.list",
          params: listParams,
          timeoutMs: 10_000,
        })) as { sessions?: Array<Record<string, unknown>> };
        return Array.isArray(result?.sessions) ? result.sessions : [];
      };

      let sessionKey = sessionKeyParam;
      if (!sessionKey && labelParam) {
        const requesterAgentId = requesterInternalKey
          ? normalizeAgentId(
              parseAgentSessionKey(requesterInternalKey)?.agentId,
            )
          : undefined;
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

        if (
          restrictToSpawned &&
          requestedAgentId &&
          requesterAgentId &&
          requestedAgentId !== requesterAgentId
        ) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error:
              "Sandboxed sessions_send label lookup is limited to this agent",
          });
        }

        if (
          requesterAgentId &&
          requestedAgentId &&
          requestedAgentId !== requesterAgentId
        ) {
          if (!a2aEnabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (
            !matchesAllow(requesterAgentId) ||
            !matchesAllow(requestedAgentId)
          ) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: requesterInternalKey } : {}),
        };
        let resolvedKey = "";
        try {
          const resolved = (await callGateway({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          })) as { key?: unknown };
          resolvedKey =
            typeof resolved?.key === "string" ? resolved.key.trim() : "";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: `Session not visible from this sandboxed agent session: label=${labelParam}`,
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
              error: `Session not visible from this sandboxed agent session: label=${labelParam}`,
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

      const resolvedKey = resolveInternalSessionKey({
        key: sessionKey,
        alias,
        mainKey,
      });

      if (restrictToSpawned) {
        const sessions = await listSessions({
          includeGlobal: false,
          includeUnknown: false,
          limit: 500,
          spawnedBy: requesterInternalKey,
        });
        const ok = sessions.some((entry) => entry?.key === resolvedKey);
        if (!ok) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: `Session not visible from this sandboxed agent session: ${sessionKey}`,
            sessionKey: resolveDisplaySessionKey({
              key: sessionKey,
              alias,
              mainKey,
            }),
          });
        }
      }
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" &&
        Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 30;
      const timeoutMs = timeoutSeconds * 1000;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      const displayKey = resolveDisplaySessionKey({
        key: sessionKey,
        alias,
        mainKey,
      });
      const requesterAgentId = normalizeAgentId(
        parseAgentSessionKey(requesterInternalKey)?.agentId,
      );
      const targetAgentId = normalizeAgentId(
        parseAgentSessionKey(resolvedKey)?.agentId,
      );
      const isCrossAgent = requesterAgentId !== targetAgentId;
      if (isCrossAgent) {
        if (!a2aEnabled) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error:
              "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            sessionKey: displayKey,
          });
        }
        if (!matchesAllow(requesterAgentId) || !matchesAllow(targetAgentId)) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error:
              "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            sessionKey: displayKey,
          });
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
      };
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterChannel = opts?.agentChannel;
      const maxPingPongTurns = resolvePingPongTurns(cfg);
      const delivery = { status: "pending", mode: "announce" as const };

      const runAgentToAgentFlow = async (
        roundOneReply?: string,
        runInfo?: { runId: string },
      ) => {
        const runContextId = runInfo?.runId ?? runId;
        try {
          let primaryReply = roundOneReply;
          let latestReply = roundOneReply;
          if (!primaryReply && runInfo?.runId) {
            const waitMs = Math.min(announceTimeoutMs, 60_000);
            const wait = (await callGateway({
              method: "agent.wait",
              params: {
                runId: runInfo.runId,
                timeoutMs: waitMs,
              },
              timeoutMs: waitMs + 2000,
            })) as { status?: string };
            if (wait?.status === "ok") {
              primaryReply = await readLatestAssistantReply({
                sessionKey: resolvedKey,
              });
              latestReply = primaryReply;
            }
          }
          if (!latestReply) return;
          const announceTarget = await resolveAnnounceTarget({
            sessionKey: resolvedKey,
            displayKey,
          });
          const targetChannel = announceTarget?.channel ?? "unknown";
          if (
            maxPingPongTurns > 0 &&
            requesterSessionKey &&
            requesterSessionKey !== resolvedKey
          ) {
            let currentSessionKey = requesterSessionKey;
            let nextSessionKey = resolvedKey;
            let incomingMessage = latestReply;
            for (let turn = 1; turn <= maxPingPongTurns; turn += 1) {
              const currentRole =
                currentSessionKey === requesterSessionKey
                  ? "requester"
                  : "target";
              const replyPrompt = buildAgentToAgentReplyContext({
                requesterSessionKey,
                requesterChannel,
                targetSessionKey: displayKey,
                targetChannel,
                currentRole,
                turn,
                maxTurns: maxPingPongTurns,
              });
              const replyText = await runAgentStep({
                sessionKey: currentSessionKey,
                message: incomingMessage,
                extraSystemPrompt: replyPrompt,
                timeoutMs: announceTimeoutMs,
                lane: AGENT_LANE_NESTED,
              });
              if (!replyText || isReplySkip(replyText)) {
                break;
              }
              latestReply = replyText;
              incomingMessage = replyText;
              const swap = currentSessionKey;
              currentSessionKey = nextSessionKey;
              nextSessionKey = swap;
            }
          }
          const announcePrompt = buildAgentToAgentAnnounceContext({
            requesterSessionKey,
            requesterChannel,
            targetSessionKey: displayKey,
            targetChannel,
            originalMessage: message,
            roundOneReply: primaryReply,
            latestReply,
          });
          const announceReply = await runAgentStep({
            sessionKey: resolvedKey,
            message: "Agent-to-agent announce step.",
            extraSystemPrompt: announcePrompt,
            timeoutMs: announceTimeoutMs,
            lane: AGENT_LANE_NESTED,
          });
          if (
            announceTarget &&
            announceReply &&
            announceReply.trim() &&
            !isAnnounceSkip(announceReply)
          ) {
            try {
              await callGateway({
                method: "send",
                params: {
                  to: announceTarget.to,
                  message: announceReply.trim(),
                  channel: announceTarget.channel,
                  accountId: announceTarget.accountId,
                  idempotencyKey: crypto.randomUUID(),
                },
                timeoutMs: 10_000,
              });
            } catch (err) {
              log.warn("sessions_send announce delivery failed", {
                runId: runContextId,
                channel: announceTarget.channel,
                to: announceTarget.to,
                error: formatErrorMessage(err),
              });
            }
          }
        } catch (err) {
          log.warn("sessions_send announce flow failed", {
            runId: runContextId,
            error: formatErrorMessage(err),
          });
        }
      };

      if (timeoutSeconds === 0) {
        try {
          const response = (await callGateway({
            method: "agent",
            params: sendParams,
            timeoutMs: 10_000,
          })) as { runId?: string; acceptedAt?: number };
          if (typeof response?.runId === "string" && response.runId) {
            runId = response.runId;
          }
          void runAgentToAgentFlow(undefined, { runId });
          return jsonResult({
            runId,
            status: "accepted",
            sessionKey: displayKey,
            delivery,
          });
        } catch (err) {
          const messageText =
            err instanceof Error
              ? err.message
              : typeof err === "string"
                ? err
                : "error";
          return jsonResult({
            runId,
            status: "error",
            error: messageText,
            sessionKey: displayKey,
          });
        }
      }

      try {
        const response = (await callGateway({
          method: "agent",
          params: sendParams,
          timeoutMs: 10_000,
        })) as { runId?: string; acceptedAt?: number };
        if (typeof response?.runId === "string" && response.runId) {
          runId = response.runId;
        }
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "error";
        return jsonResult({
          runId,
          status: "error",
          error: messageText,
          sessionKey: displayKey,
        });
      }

      let waitStatus: string | undefined;
      let waitError: string | undefined;
      try {
        const wait = (await callGateway({
          method: "agent.wait",
          params: {
            runId,
            timeoutMs,
          },
          timeoutMs: timeoutMs + 2000,
        })) as { status?: string; error?: string };
        waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
        waitError = typeof wait?.error === "string" ? wait.error : undefined;
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "error";
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

      const history = (await callGateway({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit: 50 },
      })) as { messages?: unknown[] };
      const filtered = stripToolMessages(
        Array.isArray(history?.messages) ? history.messages : [],
      );
      const last =
        filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
      const reply = last ? extractAssistantText(last) : undefined;
      void runAgentToAgentFlow(reply ?? undefined);

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
