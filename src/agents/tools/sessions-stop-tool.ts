import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { abortEmbeddedPiRun } from "../pi-embedded.js";
import { listSubagentRunsForRequester } from "../subagent-registry.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  updateSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import {
  isSubagentSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSessionReference,
} from "./sessions-helpers.js";

const SessionsStopToolSchema = Type.Object({
  sessionKey: Type.String(),
});

function resolveSandboxSessionToolsVisibility(cfg: ReturnType<typeof loadConfig>) {
  return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}

async function isSpawnedSessionAllowed(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
}): Promise<boolean> {
  const runs = listSubagentRunsForRequester(params.requesterSessionKey);
  return runs.some((run) => run.childSessionKey === params.targetSessionKey);
}

export function createSessionsStopTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Stop",
    name: "sessions_stop",
    description:
      "Stop/abort a running agent session (typically a sub-agent). Clears queued work and marks the session as aborted.",
    parameters: SessionsStopToolSchema,
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

      const resolvedKey = resolvedSession.key;
      const displayKey = resolvedSession.displayKey;
      const resolvedViaSessionId = resolvedSession.resolvedViaSessionId;

      // Validate spawned-by relationship if sandboxed
      if (restrictToSpawned && !resolvedViaSessionId) {
        const ok = await isSpawnedSessionAllowed({
          requesterSessionKey: requesterInternalKey,
          targetSessionKey: resolvedKey,
        });
        if (!ok) {
          return jsonResult({
            status: "forbidden",
            error: `Session not visible from this sandboxed agent session: ${sessionKeyParam}`,
            sessionKey: displayKey,
          });
        }
      }

      // Check agent-to-agent policy for cross-agent stops
      // Note: resolveAgentIdFromSessionKey handles undefined by defaulting to DEFAULT_AGENT_ID ("main")
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const requesterAgentId = resolveAgentIdFromSessionKey(requesterInternalKey);
      const targetAgentId = resolveAgentIdFromSessionKey(resolvedKey);
      const isCrossAgent = requesterAgentId !== targetAgentId;

      if (isCrossAgent) {
        if (!a2aPolicy.enabled) {
          return jsonResult({
            status: "forbidden",
            error:
              "Agent-to-agent session control is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent stops.",
            sessionKey: displayKey,
          });
        }
        if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
          return jsonResult({
            status: "forbidden",
            error: "Agent-to-agent session control denied by tools.agentToAgent.allow.",
            sessionKey: displayKey,
          });
        }
      }

      // Load session entry
      const parsed = parseAgentSessionKey(resolvedKey);
      const storePath = resolveStorePath(cfg.session?.store, { agentId: parsed?.agentId });
      const store = loadSessionStore(storePath);
      const entry = store[resolvedKey];
      const sessionId = entry?.sessionId;

      // Abort the running session
      const aborted = sessionId ? abortEmbeddedPiRun(sessionId) : false;

      // Clear queued work (filter out undefined to be explicit)
      const keysToClean = [resolvedKey, sessionId].filter((k): k is string => Boolean(k));
      const cleared = clearSessionQueues(keysToClean);

      if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
        logVerbose(
          `sessions_stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
        );
      }

      // Mark as aborted in session store
      if (entry) {
        const now = Date.now();
        await updateSessionStore(storePath, (nextStore) => {
          const nextEntry = nextStore[resolvedKey] ?? entry;
          if (!nextEntry) {
            return;
          }
          nextEntry.abortedLastRun = true;
          nextEntry.updatedAt = now;
          nextStore[resolvedKey] = nextEntry;
        });
      }

      const wasRunning = aborted || cleared.followupCleared > 0 || cleared.laneCleared > 0;

      return jsonResult({
        status: "ok",
        sessionKey: displayKey,
        aborted: wasRunning,
        clearedFollowups: cleared.followupCleared,
        clearedLane: cleared.laneCleared,
      });
    },
  };
}
