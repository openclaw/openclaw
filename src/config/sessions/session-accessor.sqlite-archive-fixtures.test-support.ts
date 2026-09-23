import { createHash } from "node:crypto";
import type { TrajectoryEvent } from "../../trajectory/types.js";

export type TestTranscriptEvent = {
  id: string;
  [key: string]: unknown;
};

export function createTranscriptEvent(sessionId: string, content: string): TestTranscriptEvent {
  return JSON.parse(createTranscriptEventLine(sessionId, content)) as TestTranscriptEvent;
}

export function createTranscriptEventLine(sessionId: string, content: string): string {
  return JSON.stringify({ type: "session", id: sessionId, content });
}

export function createTestTrajectoryEvent(sessionId: string): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: "test.concurrent-delete",
    ts: "2026-07-22T00:00:00.000Z",
    seq: 1,
    sessionId,
  };
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
