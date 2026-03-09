import { loadConfig } from "../../config/config.js";
import { listHeartbeatWakeSnapshotEntries } from "../../infra/heartbeat-wake.js";
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

export const activityHandlers: GatewayRequestHandlers = {
  "session.activity": ({ respond, params, context }) => {
    if (
      !assertValidParams<SessionActivityParams>(
        params,
        validateSessionActivityParams,
        "session.activity",
        respond,
      )
    ) {
      return;
    }

    const cfg = loadConfig();
    const requestedKeys = normalizeRequestedKeys(params);
    const canonicalRequestedKeys = requestedKeys.map(
      (key) => resolveGatewaySessionStoreTarget({ cfg, key }).canonicalKey,
    );
    const heartbeatByKey = new Map(
      listHeartbeatWakeSnapshotEntries()
        .filter(
          (entry): entry is typeof entry & { sessionKey: string } =>
            typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0,
        )
        .map((entry) => [entry.sessionKey, entry] as const),
    );

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
