import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticMemoryUsage,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "../logging/diagnostic-stability.js";

const MB = 1024 * 1024;
const SYNTHETIC_BATCH_COUNT = 200;
const SYNTHETIC_SESSION_COUNT = 8;
const STABILITY_REASON = "stability_probe";

function memoryUsageForBatch(index: number): DiagnosticMemoryUsage {
  return {
    rssBytes: 180 * MB + index * 64 * 1024,
    heapTotalBytes: 96 * MB,
    heapUsedBytes: 70 * MB + (index % 12) * 256 * 1024,
    externalBytes: 8 * MB,
    arrayBuffersBytes: 2 * MB,
  };
}

function emitSyntheticGatewayStabilityLoad(): number {
  const startedAt = 1_800_000_000_000;
  let maxRssBytes = 0;
  for (let index = 0; index < SYNTHETIC_BATCH_COUNT; index += 1) {
    const sessionIndex = index % SYNTHETIC_SESSION_COUNT;
    const session = {
      sessionKey: `agent:main:stability-${sessionIndex}`,
      sessionId: `session-${sessionIndex}`,
    };
    const sessionState = { ...session, type: "session.state" as const, reason: STABILITY_REASON };
    emitDiagnosticEvent({
      type: "message.queued",
      ...session,
      channel: "gateway",
      source: "stability-probe",
      queueDepth: 1,
    });
    emitDiagnosticEvent({
      ...sessionState,
      state: "processing",
      queueDepth: 1,
    });

    const memoryUsage = memoryUsageForBatch(index);
    maxRssBytes = Math.max(maxRssBytes, memoryUsage.rssBytes);
    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory: memoryUsage,
      uptimeMs: startedAt + index * 1_000,
    });

    if (index % 5 === 0) {
      emitDiagnosticEvent({
        type: "payload.large",
        surface: "gateway.stability.probe",
        action: "chunked",
        bytes: 3 * MB + index,
        limitBytes: 2 * MB,
        count: 2,
        reason: STABILITY_REASON,
        channel: "gateway",
      });
    }

    emitDiagnosticEvent({
      ...sessionState,
      state: "idle",
      queueDepth: 0,
    });
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "gateway",
      ...session,
      outcome: "completed",
      durationMs: 5,
      reason: STABILITY_REASON,
    });
  }
  return maxRssBytes;
}

describe("gateway stability lane", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    startDiagnosticStabilityRecorder();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  it("keeps diagnostics bounded and queues drained under synthetic gateway churn", () => {
    const initial = getDiagnosticStabilitySnapshot({ limit: 1 });
    expect(initial.capacity).toBe(1000);

    const maxSyntheticRssBytes = emitSyntheticGatewayStabilityLoad();
    const snapshot = getDiagnosticStabilitySnapshot({ limit: 1000 });

    expect(snapshot).toMatchObject({ capacity: 1000, count: 1000 });
    expect(snapshot.events).toHaveLength(1000);
    expect(snapshot.dropped).toBeGreaterThan(0);
    const firstSeq = snapshot.firstSeq ?? 0;
    const lastSeq = snapshot.lastSeq ?? 0;
    expect(firstSeq).toBeGreaterThan(1);
    expect(lastSeq).toBeGreaterThan(firstSeq);
    expect(snapshot.summary.byType["diagnostic.memory.sample"]).toBeGreaterThan(0);
    expect(snapshot.summary.byType["message.queued"]).toBeGreaterThan(0);
    expect(snapshot.summary.memory?.maxRssBytes).toBe(maxSyntheticRssBytes);
    expect(snapshot.summary.memory?.pressureCount).toBe(0);
    expect(snapshot.summary.memory?.maxHeapUsedBytes).toBeLessThan(96 * MB);
    expect(snapshot.summary.payloadLarge?.chunked).toBeGreaterThan(0);
    expect(snapshot.summary.payloadLarge?.bySurface["gateway.stability.probe"]).toBeGreaterThan(0);

    const sessionEvents = snapshot.events.filter((event) => event.type === "session.state");
    expect(sessionEvents.length).toBeGreaterThan(0);
    for (const event of sessionEvents) {
      expect(event).not.toHaveProperty("sessionId");
      expect(event).not.toHaveProperty("sessionKey");
      expect(event.reason).toBe(STABILITY_REASON);
    }
    const idleDrainedEvents = sessionEvents.filter(
      (event) => event.outcome === "idle" && event.queueDepth === 0,
    );
    expect(idleDrainedEvents.length).toBeGreaterThan(0);

    stopDiagnosticStabilityRecorder();
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.stability.after-close",
      action: "rejected",
    });
    expect(getDiagnosticStabilitySnapshot({ limit: 1 }).lastSeq).toBe(lastSeq);
  });
});
