import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { getRuntimeConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  resolveSandboxedSessionToolContext,
  type SessionListRow,
} from "./sessions-helpers.js";

const SessionsBroadcastToolSchema = Type.Object({
  message: Type.String({ minLength: 1 }),
  agentIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }))),
  kinds: Type.Optional(Type.Array(Type.String())),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  activeWithinMinutes: Type.Optional(Type.Number({ minimum: 1 })),
  excludeCurrentSession: Type.Optional(Type.Boolean()),
});

export type SessionBroadcastResultEntry = {
  sessionKey: string;
  agentId?: string;
  kind?: string;
  label?: string;
  status: "delivered" | "failed" | "skipped";
  reason?: string;
};

export type SessionsBroadcastResult = {
  delivered: number;
  failed: number;
  skipped: number;
  results: SessionBroadcastResultEntry[];
};

type GatewayCaller = typeof callGateway;

export function createSessionsBroadcastTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session Broadcast",
    name: "sessions_broadcast",
    description:
      "Broadcast a system event message to multiple sessions that match a filter. At least one filter (agentIds, kinds, label, or activeWithinMinutes) is required to prevent accidental cluster-wide broadcast. The calling session is excluded by default (excludeCurrentSession: true).",
    parameters: SessionsBroadcastToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;

      const message = readStringParam(params, "message", { required: true });

      // Resolve session context
      const cfg = opts?.config ?? getRuntimeConfig();
      const { alias, requesterInternalKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const effectiveRequesterKey = requesterInternalKey ?? alias;

      // Check agentToAgent policy
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      if (!a2aPolicy.enabled) {
        return jsonResult({
          error:
            "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to use sessions_broadcast.",
        });
      }

      // Parse filter params
      const agentIdsRaw = Array.isArray(params.agentIds)
        ? (params.agentIds as unknown[])
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .filter(Boolean)
        : undefined;
      const kindsRaw = Array.isArray(params.kinds)
        ? (params.kinds as unknown[])
            .map((v) => (typeof v === "string" ? v.toLowerCase().trim() : ""))
            .filter(Boolean)
        : undefined;
      const label = readStringParam(params, "label")?.trim() || undefined;
      const activeWithinMinutes =
        typeof params.activeWithinMinutes === "number" &&
        Number.isFinite(params.activeWithinMinutes)
          ? Math.max(1, Math.floor(params.activeWithinMinutes))
          : undefined;

      // Safety gate: at least one filter required
      const hasFilter =
        (agentIdsRaw && agentIdsRaw.length > 0) ||
        (kindsRaw && kindsRaw.length > 0) ||
        label !== undefined ||
        activeWithinMinutes !== undefined;

      if (!hasFilter) {
        return jsonResult({
          error:
            "sessions_broadcast requires at least one filter (agentIds, kinds, label, or activeWithinMinutes) to prevent accidental cluster-wide broadcast.",
        });
      }

      const excludeSelf =
        typeof params.excludeCurrentSession === "boolean" ? params.excludeCurrentSession : true;

      // Fan out: for each agentId filter or single request, resolve sessions
      const resolvedSessions: SessionListRow[] = [];

      if (agentIdsRaw && agentIdsRaw.length > 0) {
        // Fetch sessions for each specified agentId
        for (const agentId of agentIdsRaw) {
          try {
            const list = await gatewayCall<{ sessions: Array<SessionListRow> }>({
              method: "sessions.list",
              params: {
                agentId,
                ...(activeWithinMinutes !== undefined ? { activeMinutes: activeWithinMinutes } : {}),
                ...(label !== undefined ? { label } : {}),
                includeGlobal: !restrictToSpawned,
                includeUnknown: !restrictToSpawned,
                spawnedBy: restrictToSpawned ? effectiveRequesterKey : undefined,
              },
            });
            const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
            resolvedSessions.push(...sessions);
          } catch {
            // continue — session list error for one agentId should not block others
          }
        }
      } else {
        // No agentIds filter — fetch by label/kinds/activeWithinMinutes
        try {
          const list = await gatewayCall<{ sessions: Array<SessionListRow> }>({
            method: "sessions.list",
            params: {
              ...(label !== undefined ? { label } : {}),
              ...(activeWithinMinutes !== undefined ? { activeMinutes: activeWithinMinutes } : {}),
              includeGlobal: !restrictToSpawned,
              includeUnknown: !restrictToSpawned,
              spawnedBy: restrictToSpawned ? effectiveRequesterKey : undefined,
            },
          });
          const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
          resolvedSessions.push(...sessions);
        } catch {
          // fall through — resolvedSessions stays empty
        }
      }

      // De-duplicate by key
      const seenKeys = new Set<string>();
      const uniqueSessions: SessionListRow[] = [];
      for (const session of resolvedSessions) {
        const key = typeof session.key === "string" ? session.key.trim() : "";
        if (!key || seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        uniqueSessions.push(session);
      }

      const results: SessionBroadcastResultEntry[] = [];
      let delivered = 0;
      let failed = 0;
      let skipped = 0;

      const callerRequesterAgentId = opts?.agentSessionKey
        ? resolveAgentIdFromSessionKey(opts.agentSessionKey)
        : undefined;

      for (const session of uniqueSessions) {
        const key = typeof session.key === "string" ? session.key.trim() : "";
        if (!key || key === "unknown" || key === "global") {
          continue;
        }

        const sessionAgentId = typeof session.agentId === "string" ? session.agentId : undefined;
        const sessionKind = typeof session.kind === "string" ? session.kind : undefined;
        const sessionLabel = typeof session.label === "string" ? session.label : undefined;

        const entry: SessionBroadcastResultEntry = {
          sessionKey: key,
          ...(sessionAgentId !== undefined ? { agentId: sessionAgentId } : {}),
          ...(sessionKind !== undefined ? { kind: sessionKind } : {}),
          ...(sessionLabel !== undefined ? { label: sessionLabel } : {}),
          status: "delivered",
        };

        // Kind filter (post-fetch filter since gateway sessions.list may not filter by kind)
        if (kindsRaw && kindsRaw.length > 0 && sessionKind) {
          if (!kindsRaw.includes(sessionKind)) {
            entry.status = "skipped";
            entry.reason = "kind-filter";
            results.push(entry);
            skipped += 1;
            continue;
          }
        }

        // Exclude self
        if (excludeSelf && opts?.agentSessionKey && key === opts.agentSessionKey) {
          entry.status = "skipped";
          entry.reason = "self";
          results.push(entry);
          skipped += 1;
          continue;
        }

        // Exclude thread-scoped sessions
        if (key.includes(":thread:")) {
          entry.status = "skipped";
          entry.reason = "thread-scoped";
          results.push(entry);
          skipped += 1;
          continue;
        }

        // Enforce allow-list: check if the target agentId is allowed
        if (sessionAgentId && callerRequesterAgentId && sessionAgentId !== callerRequesterAgentId) {
          if (!a2aPolicy.isAllowed(callerRequesterAgentId, sessionAgentId)) {
            entry.status = "skipped";
            entry.reason = "allow-list";
            results.push(entry);
            skipped += 1;
            continue;
          }
        }

        // Deliver via enqueueSystemEvent
        try {
          const queued = enqueueSystemEvent(message, {
            sessionKey: key,
            trusted: false,
          });
          if (queued === false) {
            entry.status = "failed";
            entry.reason = "queue-rejected";
            results.push(entry);
            failed += 1;
          } else {
            results.push(entry);
            delivered += 1;
          }
        } catch (err) {
          entry.status = "failed";
          entry.reason = err instanceof Error ? err.message : "delivery-error";
          results.push(entry);
          failed += 1;
        }
      }

      const broadcastResult: SessionsBroadcastResult = {
        delivered,
        failed,
        skipped,
        results,
      };
      return jsonResult(broadcastResult);
    },
  };
}
