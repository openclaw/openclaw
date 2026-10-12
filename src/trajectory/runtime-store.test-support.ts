import { appendSqliteTrajectoryRuntimeEvents as appendSerializedTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

export function appendSqliteTrajectoryRuntimeEvents(
  scope: Parameters<typeof appendSerializedTrajectoryRuntimeEvents>[0],
  events: readonly TrajectoryEvent[],
): void {
  appendSerializedTrajectoryRuntimeEvents(
    scope,
    events.map((event) => ({ runId: event.runId, ts: event.ts, line: JSON.stringify(event) })),
  );
}

export function createTrajectoryEvent(options: {
  payloadSize?: number;
  runId?: string;
  seq?: number;
  sessionId?: string;
  ts?: string;
  type: string;
}): TrajectoryEvent {
  const sessionId = options.sessionId ?? "session-1";
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: options.type,
    ts: options.ts ?? "2026-07-03T00:00:00.000Z",
    seq: options.seq ?? 1,
    sourceSeq: options.seq ?? 1,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    runId: options.runId ?? "run-1",
    data: { payload: "x".repeat(options.payloadSize ?? 120) },
  };
}
