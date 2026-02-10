import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { jsonResult, readStringParam } from "./common.js";
import { stringEnum } from "../schema/typebox.js";
import {
  createAgentToAgentPolicy,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSessionReference,
  type SessionListRow,
} from "./sessions-helpers.js";

const SESSIONS_MANAGE_ACTIONS = ["compact", "reset"] as const;

const SessionsManageToolSchema = Type.Object({
  sessionKey: Type.String(),
  action: stringEnum(SESSIONS_MANAGE_ACTIONS),
});

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

export function createSessionsManageTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Manage",
    name: "sessions_manage",
    description: "Compact or reset another session by key.",
    parameters: SessionsManageToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKeyParam = readStringParam(params, "sessionKey", {
        required: true,
      });
      const action = readStringParam(params, "action", { required: true });
      if (!SESSIONS_MANAGE_ACTIONS.includes(action as (typeof SESSIONS_MANAGE_ACTIONS)[number])) {
        return jsonResult({ status: "error", error: "action must be compact or reset" });
      }

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

      const resolvedKey = resolvedSession.key;
      const displayKey = resolvedSession.displayKey;
      const resolvedViaSessionId = resolvedSession.resolvedViaSessionId;
      if (restrictToSpawned) {
        // Even if resolved via sessionId, we must verify visibility to prevent unauthorized access by guessing IDs.
        const ok = await isSpawnedSessionAllowed({
          requesterSessionKey: requesterInternalKey!,
          targetSessionKey: resolvedKey,
        });
        if (!ok) {
          return jsonResult({
            status: "forbidden",
            error: `Session not visible from this sandboxed agent session: ${sessionKeyParam}`,
          });
        }
      }

      const requesterAgentId = requesterInternalKey
        ? resolveAgentIdFromSessionKey(requesterInternalKey)
        : "main";
      const targetAgentId = resolveAgentIdFromSessionKey(resolvedKey);
      const isCrossAgent = requesterAgentId !== targetAgentId;

      // If we don't know who is asking (and they aren't explicitly "main"), we can't safely allow cross-agent access.
      // For sandboxed agents, requesterInternalKey is required (checked above implicitly by restrictToSpawned logic, but explicit check is safer).
      if (opts?.sandboxed && !requesterInternalKey) {
        return jsonResult({
          status: "forbidden",
          error: "Sandboxed agent session key missing; cannot verify permissions.",
        });
      }
      if (isCrossAgent) {
        if (!a2aPolicy.enabled) {
          return jsonResult({
            status: "forbidden",
            error:
              "Agent-to-agent session management is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.",
          });
        }
        if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
          return jsonResult({
            status: "forbidden",
            error: "Agent-to-agent session management denied by tools.agentToAgent.allow.",
          });
        }
      }

      if (action === "compact") {
        const result = await callGateway<{ compacted?: boolean; reason?: string }>({
          method: "sessions.compact",
          params: { key: resolvedKey },
        });
        return jsonResult({
          status: "ok",
          action,
          sessionKey: displayKey,
          compacted: result?.compacted === true,
          reason: typeof result?.reason === "string" ? result.reason : undefined,
        });
      }

      const result = await callGateway<{ key?: string; deleted?: boolean; archived?: string[] }>({
        method: "sessions.reset",
        params: { key: resolvedKey },
      });
      return jsonResult({
        status: "ok",
        action,
        sessionKey: displayKey,
        key: typeof result?.key === "string" ? result.key : undefined,
        deleted: result?.deleted === true,
        archived: Array.isArray(result?.archived) ? result.archived : [],
      });
    },
  };
}
