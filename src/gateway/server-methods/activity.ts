import { loadConfig } from "../../config/config.js";
import {
  listHeartbeatWakeSnapshotEntries,
  type HeartbeatWakeSnapshotEntry,
} from "../../infra/heartbeat-wake.js";
import { validateSessionActivityParams, type SessionActivityParams } from "../protocol/index.js";
import { resolveGatewaySessionStoreTarget } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function normalizeRequestedKeys(params: SessionActivityParams): string[] {
  const keys = new Set<string>();
  if (typeof params.key === "string" && params.key.trim()) {
    keys.add(params.key.trim());
  }
  if (Array.isArray(params.keys)) {
    for (const key of params.keys) {
      if (typeof key === "string" && key.trim()) {
        keys.add(key.trim());
      }
    }
  }
  return [...keys];
}

function toCanonicalSessionKey(cfg: ReturnType<typeof loadConfig>, key: string): string {
  return resolveGatewaySessionStoreTarget({ cfg, key }).canonicalKey;
}

function heartbeatSnapshotSortKey(entry: HeartbeatWakeSnapshotEntry): number {
  return entry.startedAt ?? entry.requestedAt;
}

function selectHeartbeatSnapshotEntry(
  current: HeartbeatWakeSnapshotEntry | undefined,
  next: HeartbeatWakeSnapshotEntry,
): HeartbeatWakeSnapshotEntry {
  if (!current) {
    return next;
  }
  if (current.phase !== next.phase) {
    return current.phase === "running" ? current : next;
  }
  return heartbeatSnapshotSortKey(next) >= heartbeatSnapshotSortKey(current) ? next : current;
}

export const activityHandlers: GatewayRequestHandlers = {
  "sessions.activity": ({ respond, params, context }) => {
    if (
      !assertValidParams<SessionActivityParams>(
        params,
        validateSessionActivityParams,
        "sessions.activity",
        respond,
      )
    ) {
      return;
    }

    const cfg = loadConfig();
    const requestedKeys = normalizeRequestedKeys(params);
    const canonicalRequestedKeys = requestedKeys.map((key) => toCanonicalSessionKey(cfg, key));
    const heartbeatByKey = new Map<string, HeartbeatWakeSnapshotEntry>();
    for (const entry of listHeartbeatWakeSnapshotEntries()) {
      if (typeof entry.sessionKey !== "string" || entry.sessionKey.trim().length === 0) {
        continue;
      }
      const canonicalKey = toCanonicalSessionKey(cfg, entry.sessionKey);
      heartbeatByKey.set(
        canonicalKey,
        selectHeartbeatSnapshotEntry(heartbeatByKey.get(canonicalKey), entry),
      );
    }

    const keys =
      canonicalRequestedKeys.length > 0
        ? canonicalRequestedKeys
        : Array.from(
            new Set([...context.sessionActivity.listActiveSessionKeys(), ...heartbeatByKey.keys()]),
          ).toSorted();

    const sessions = keys.map((key) => {
      const running = context.sessionActivity.getRunning(key);
      if (running) {
        return running;
      }
      const heartbeat = heartbeatByKey.get(key);
      if (heartbeat) {
        return {
          key,
          phase: heartbeat.phase,
          source: "heartbeat" as const,
          startedAt: heartbeat.startedAt,
          lastActivityAt: heartbeat.startedAt ?? heartbeat.requestedAt,
        };
      }
      return {
        key,
        phase: "idle" as const,
        source: null,
      };
    });

    respond(true, { ts: Date.now(), sessions }, undefined);
  },
};
