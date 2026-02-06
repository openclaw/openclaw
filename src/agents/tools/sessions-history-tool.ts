import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { capArrayByJsonBytes } from "../../gateway/session-utils.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  resolveSessionReference,
  resolveMainSessionAlias,
  resolveInternalSessionKey,
  SessionListRow,
  stripToolMessages,
} from "./sessions-helpers.js";

const SessionsHistoryToolSchema = Type.Object({
  sessionKey: Type.String(),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  includeTools: Type.Optional(Type.Boolean()),
});

const SESSIONS_HISTORY_MAX_BYTES = 80 * 1024;
const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4000;

function truncateHistoryText(text: string): string {
  if (text.length <= SESSIONS_HISTORY_TEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, SESSIONS_HISTORY_TEXT_MAX_CHARS)}\n…(truncated)…`;
}

function sanitizeHistoryContentBlock(block: unknown): unknown {
  if (!block || typeof block !== "object") {
    return block;
  }
  const entry = { ...(block as Record<string, unknown>) };
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "text" && typeof entry.text === "string") {
    entry.text = truncateHistoryText(entry.text);
  }
  if (type === "thinking") {
    if (typeof entry.thinking === "string") {
      entry.thinking = truncateHistoryText(entry.thinking);
    }
    // The encrypted signature can be extremely large and is not useful for history recall.
    delete entry.thinkingSignature;
  }
  if (typeof entry.partialJson === "string") {
    entry.partialJson = truncateHistoryText(entry.partialJson);
  }
  if (type === "image") {
    delete entry.data;
    entry.omitted = true;
  }
  return entry;
}

function sanitizeHistoryMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const entry = { ...(message as Record<string, unknown>) };
  // Tool result details often contain very large nested payloads.
  delete entry.details;
  delete entry.usage;
  delete entry.cost;

  if (typeof entry.content === "string") {
    entry.content = truncateHistoryText(entry.content);
  } else if (Array.isArray(entry.content)) {
    entry.content = entry.content.map((block) => sanitizeHistoryContentBlock(block));
  }
  return entry;
}

function resolveSandboxSessionToolsVisibility(cfg: ReturnType<typeof loadConfig>) {
  return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}

async function isSpawnedSessionAllowed(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
}): Promise<boolean> {
  try {
    const list = await callGateway<{ sessions: Array<SessionListRow> }>({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        limit: 500,
        spawnedBy: params.requesterSessionKey,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    return sessions.some((entry) => entry?.key === params.targetSessionKey);
  } catch {
    return false;
  }
}

export function createSessionsHistoryTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session History",
    name: "sessions_history",
    description: "Fetch message history for a session.",
    parameters: SessionsHistoryToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKeyParam = readStringParam(params, "sessionKey", {
        required: true,
      });
      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const visibility = resolveSandboxSessionToolsVisibility(cfg);
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
        !!requesterInternalKey &&
        !isSubagentSessionKey(requesterInternalKey);
      const resolvedSession = await resolveSessionReference({
        sessionKey: sessionKeyParam,
        alias,
        mainKey,
        requesterInternalKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
      }
      // From here on, use the canonical key (sessionId inputs already resolved).
      const resolvedKey = resolvedSession.key;
      const displayKey = resolvedSession.displayKey;
      const resolvedViaSessionId = resolvedSession.resolvedViaSessionId;
      if (restrictToSpawned && !resolvedViaSessionId) {
        const ok = await isSpawnedSessionAllowed({
          requesterSessionKey: requesterInternalKey,
          targetSessionKey: resolvedKey,
        });
        if (!ok) {
          return jsonResult({
            status: "forbidden",
            error: `Session not visible from this sandboxed agent session: ${sessionKeyParam}`,
          });
        }
      }

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const requesterAgentId = resolveAgentIdFromSessionKey(requesterInternalKey);
      const targetAgentId = resolveAgentIdFromSessionKey(resolvedKey);
      const isCrossAgent = requesterAgentId !== targetAgentId;
      if (isCrossAgent) {
        if (!a2aPolicy.enabled) {
          return jsonResult({
            status: "forbidden",
            error:
              "Agent-to-agent history is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.",
          });
        }
        if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
          return jsonResult({
            status: "forbidden",
            error: "Agent-to-agent history denied by tools.agentToAgent.allow.",
          });
        }
      }

      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : undefined;
      const includeTools = Boolean(params.includeTools);
      const result = await callGateway<{ messages: Array<unknown> }>({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit },
      });
      const rawMessages = Array.isArray(result?.messages) ? result.messages : [];
      const selectedMessages = includeTools ? rawMessages : stripToolMessages(rawMessages);
      const sanitizedMessages = selectedMessages.map((message) => sanitizeHistoryMessage(message));
      const cappedMessages = capArrayByJsonBytes(sanitizedMessages, SESSIONS_HISTORY_MAX_BYTES);
      return jsonResult({
        sessionKey: displayKey,
        messages: cappedMessages.items,
        truncated: cappedMessages.items.length < selectedMessages.length,
        bytes: cappedMessages.bytes,
      });
    },
  };
}
