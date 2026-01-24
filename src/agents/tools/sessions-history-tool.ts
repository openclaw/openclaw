import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  resolveSessionReference,
  resolveMainSessionAlias,
  resolveInternalSessionKey,
  stripToolMessages,
} from "./sessions-helpers.js";

const SessionsHistoryToolSchema = Type.Object({
  sessionKey: Type.String(),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  includeTools: Type.Optional(Type.Boolean()),
});

function resolveSandboxSessionToolsVisibility(cfg: ReturnType<typeof loadConfig>) {
  return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}

async function isSpawnedSessionAllowed(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
}): Promise<boolean> {
  try {
    const list = (await callGateway({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        limit: 500,
        spawnedBy: params.requesterSessionKey,
      },
    })) as { sessions?: Array<Record<string, unknown>> };
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
      const result = (await callGateway({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit },
      })) as { messages?: unknown[] };
      const rawMessages = Array.isArray(result?.messages) ? result.messages : [];
      const messages = includeTools ? rawMessages : stripToolMessages(rawMessages);
      return jsonResult({
        sessionKey: displayKey,
        messages,
      });
    },
  };
}
