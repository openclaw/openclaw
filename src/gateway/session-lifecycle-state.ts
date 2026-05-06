import { updateSessionStoreEntry, type SessionEntry } from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow, SessionRunStatus } from "./session-utils.types.js";

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts"> & {
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
    yielded?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun" | "pauseReason"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun" | "pauseReason"
>;

type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: LifecycleEventLike): LifecyclePhase | null {
  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

function resolveYielded(event: LifecycleEventLike): boolean {
  return event.data?.yielded === true;
}

function resolveTerminalStatus(event: LifecycleEventLike): SessionRunStatus {
  const phase = resolveLifecyclePhase(event);
  if (phase === "error") {
    return "failed";
  }

  // A `sessions_yield` tool call ends the run cleanly while the session
  // remains active waiting for a queued continuation. Mark it paused instead
  // of done so consumers (restart recovery, dashboards, channels) do not
  // race the follow-up turn.
  if (resolveYielded(event)) {
    return "paused";
  }

  const stopReason = typeof event.data?.stopReason === "string" ? event.data.stopReason : "";
  if (stopReason === "aborted") {
    return "killed";
  }

  return event.data?.aborted === true ? "timeout" : "done";
}

function resolveLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: LifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveLifecycleEndedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<LifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
      // A fresh run drains the previously queued yield continuation, so the
      // paused marker no longer applies. Mirrors how the subagent registry
      // clears `pauseReason` on completion (see subagent-registry-lifecycle).
      pauseReason: undefined,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  const terminalStatus = resolveTerminalStatus(params.event);
  return {
    updatedAt,
    status: terminalStatus,
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({
      startedAt,
      endedAt,
      existingRuntimeMs: existing?.runtimeMs,
    }),
    abortedLastRun: terminalStatus === "killed",
    // Gate the marker on the derived terminal status so error end-events
    // carrying `yielded: true` do not leak `sessions_yield` into failed rows.
    pauseReason: terminalStatus === "paused" ? "sessions_yield" : undefined,
  };
}

export function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  return {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
  };
}

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  event: LifecycleEventLike;
}): Promise<void> {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return;
  }

  const sessionEntry = loadSessionEntry(params.sessionKey);
  if (!sessionEntry.entry) {
    return;
  }

  await updateSessionStoreEntry({
    storePath: sessionEntry.storePath,
    sessionKey: sessionEntry.canonicalKey,
    update: async (entry) =>
      derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
      }),
  });
}
