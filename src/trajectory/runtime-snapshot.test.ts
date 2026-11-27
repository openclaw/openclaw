import { describe, expect, it } from "vitest";
import {
  TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES,
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
} from "./paths.js";
import { fragmentTrajectorySnapshot, restoreTrajectorySnapshots } from "./runtime-snapshot.js";
import type { TrajectoryEvent } from "./types.js";

const snapshot = Array.from({ length: 12 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  content: `message ${index} ${"text 🦊 ".repeat(4000)}`,
}));
const event: TrajectoryEvent = {
  traceSchema: "openclaw-trajectory",
  schemaVersion: 1,
  traceId: "session",
  source: "runtime",
  type: "model.completed",
  ts: "2026-11-28T00:00:00Z",
  seq: 4,
  sourceSeq: 4,
  sessionId: "session",
  runId: "run",
  data: { messagesSnapshot: snapshot, stopReason: "stop" },
};
function records(runId = event.runId) {
  const current = { ...event, runId };
  return fragmentTrajectorySnapshot(
    current,
    Buffer.byteLength(JSON.stringify(current)),
    TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES,
  )!;
}

describe("prepared trajectory snapshots", () => {
  it("round-trips Unicode and order without changing the input or row and window limits", () => {
    const before = JSON.stringify(event);
    const encoded = records();
    expect(
      encoded.every(({ line }) => Buffer.byteLength(line) <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES),
    ).toBe(true);
    expect(
      encoded.reduce((sum, { line }) => sum + Buffer.byteLength(line) + 1, 0),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES);
    const decoded = restoreTrajectorySnapshots(encoded.map(({ line }) => JSON.parse(line)));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.data).toEqual(event.data);
    expect(JSON.stringify(event)).toBe(before);
  });

  it("keeps incomplete, duplicated, altered and wrong-context groups explicitly partial", () => {
    for (const mutation of ["missing", "duplicate", "payload", "context", "index", "digest"]) {
      const encoded = records().map(({ line }) => JSON.parse(line) as TrajectoryEvent);
      if (mutation === "missing") {
        encoded.shift();
      }
      if (mutation === "duplicate") {
        encoded.splice(1, 0, structuredClone(encoded[0]!));
      }
      if (mutation === "payload") {
        encoded[0]!.data!.messagesSnapshot = [];
      }
      if (mutation === "context") {
        encoded[0]!.sessionKey = "another-chat";
      }
      if (mutation === "index") {
        encoded[0]!.data!.index = 9;
      }
      if (mutation === "digest") {
        encoded[0]!.data!.integrityToken = "0".repeat(64);
      }
      const decoded = restoreTrajectorySnapshots(encoded);
      expect(decoded, mutation).toHaveLength(1);
      expect(decoded.at(-1)?.data?.truncated, mutation).toBe(true);
      expect(decoded.at(-1)?.data?.messagesSnapshot, mutation).toBeUndefined();
      expect(JSON.stringify(decoded)).not.toContain('"integrityToken"');
      expect(JSON.stringify(decoded)).not.toContain('"messagesSnapshotFragments"');
    }
  });

  it("preserves other loss markers and orphan fragments", () => {
    const encoded = records().map(({ line }) => JSON.parse(line) as TrajectoryEvent);
    encoded.at(-1)!.data!.droppedFields = ["messagesSnapshot", "other"];
    const decoded = restoreTrajectorySnapshots(encoded);
    expect(decoded[0]?.data?.messagesSnapshot).toEqual(snapshot);
    expect(decoded[0]?.data?.droppedFields).toEqual(["other"]);
    expect(decoded[0]?.data?.truncated).toBe(true);
    const orphan = restoreTrajectorySnapshots(encoded.slice(0, -1));
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.data).toEqual({ truncated: true, reason: "incomplete-trajectory-snapshot" });
  });

  it("does not enlarge the capture budget or split an oversized individual message", () => {
    expect(fragmentTrajectorySnapshot(event, 500000, 1024)).toBeUndefined();
    const oversized = { ...event, data: { messagesSnapshot: [{ content: "x".repeat(300000) }] } };
    expect(
      fragmentTrajectorySnapshot(oversized, 300000, TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES),
    ).toBeUndefined();
  });

  it("keeps repeated recorder sequences in separate groups", () => {
    const first = records(),
      second = records("second-run");
    const decoded = restoreTrajectorySnapshots(
      [...first, ...second].map(({ line }) => JSON.parse(line)),
    );
    expect(decoded).toHaveLength(2);
    expect(decoded.map((part) => part.data?.messagesSnapshot)).toEqual([snapshot, snapshot]);
    const mixed = restoreTrajectorySnapshots(
      [second[0]!, ...first.slice(1)].map(({ line }) => JSON.parse(line)),
    );
    expect(mixed.find((part) => part.type === "model.completed")?.data?.truncated).toBe(true);
    expect(mixed.some((part) => part.data?.messagesSnapshot)).toBe(false);
  });
});
