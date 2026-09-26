import type { TrajectoryEvent } from "../../trajectory/types.js";

export function createTestTrajectoryEvent(sessionId: string): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: "test.concurrent-write",
    ts: "2026-07-09T00:00:00.000Z",
    seq: 1,
    sessionId,
  };
}

export function createManualCompactRecords(sessionId: string) {
  return [
    { type: "session", version: 3, id: sessionId, timestamp: "2026-06-19T12:00:00.000Z" },
    ...[1, 2, 3, 4].map((index) => ({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 1 ? null : `entry-${index - 1}`,
      timestamp: `2026-06-19T12:00:0${index}.000Z`,
      message: { role: "user", content: `message ${index}`, timestamp: index },
    })),
  ];
}
