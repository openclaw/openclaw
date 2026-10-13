import { describe, expect, it } from "vitest";
import { attributeWriterOccupancy } from "../../scripts/diagnostic-writer-occupancy.mts";

function warning(
  fields: Record<string, unknown> = {},
  time = "2026-10-13T14:01:01.500Z",
  message = "slow SQLite session write",
) {
  return JSON.stringify({
    "0": '{"subsystem":"session-sqlite"}',
    "1": {
      operation: "session-entry.patch",
      pid: 123,
      threadId: 0,
      reentrant: false,
      elapsedMs: 3_500,
      queueWaitMs: 1_000,
      writerExecutionMs: 2_000,
      completionDelayMs: 500,
      ...fields,
    },
    "2": message,
    _meta: { logLevelName: "WARN" },
    time,
  });
}

describe("writer occupancy log report", () => {
  it("splits historic warning intervals at minute boundaries without double-counting nested work", async () => {
    const report = await attributeWriterOccupancy([
      warning(),
      warning({ reentrant: true }),
      warning({}, undefined, "slow session lifecycle operation"),
      warning({}, undefined, "session lifecycle queue waiting"),
    ]);
    expect(report.observedReservations).toBe(1);
    expect(report.ignoredLines).toBe(3);
    expect(report.operations).toEqual([
      {
        operation: "session-entry.patch",
        count: 1,
        reservationMs: 2_000,
        queueWaitMs: 1_000,
        maxReservationMs: 2_000,
      },
    ]);
    expect(report.minutes).toEqual([
      {
        minute: "2026-10-13T14:00:00.000Z",
        maxObservedWaitOverlap: 1,
        operations: [
          { operation: "session-entry.patch", reservationMs: 1_000, queueWaitMs: 1_000 },
        ],
      },
      {
        minute: "2026-10-13T14:01:00.000Z",
        maxObservedWaitOverlap: 0,
        operations: [{ operation: "session-entry.patch", reservationMs: 1_000, queueWaitMs: 0 }],
      },
    ]);
    expect(report.topReservations).toEqual([
      {
        estimatedEnd: "2026-10-13T14:01:01.000Z",
        operation: "session-entry.patch",
        reservationMs: 2_000,
        queueWaitMs: 1_000,
      },
    ]);
  });

  it("counts simultaneous observed waits only within the same process/thread", async () => {
    const report = await attributeWriterOccupancy([
      warning({ operation: "direct" }, undefined, "slow agent database reservation"),
      warning({ operation: "session.entry-replacements" }),
      warning({ pid: 456 }),
      warning({ threadId: 1 }),
      // A wait beginning exactly where the preceding waits end does not overlap them.
      warning({}, "2026-10-13T14:01:02.500Z", "SQLite session write failed"),
    ]);
    expect(report.observedReservations).toBe(5);
    expect(report.minutes[0]?.maxObservedWaitOverlap).toBe(2);
    expect(report.minutes[1]?.maxObservedWaitOverlap).toBe(0);
    expect(report.operations.find((row) => row.operation === "direct")?.reservationMs).toBe(2_000);
  });

  it("clips intervals using offset-qualified bounds, including warnings emitted after the window", async () => {
    const report = await attributeWriterOccupancy([warning()], {
      from: "2026-10-13T07:00:59.500-07:00",
      until: "2026-10-13T14:01:00.500+00:00",
    });
    expect(report.operations[0]).toMatchObject({
      reservationMs: 1_000,
      queueWaitMs: 0,
      maxReservationMs: 1_000,
    });
    expect(report.minutes.map((row) => row.operations[0]?.reservationMs)).toEqual([500, 500]);
    expect(report.topReservations).toEqual([
      {
        estimatedEnd: "2026-10-13T14:01:00.500Z",
        operation: "session-entry.patch",
        reservationMs: 1_000,
        queueWaitMs: 0,
      },
    ]);
    const waitOnly = await attributeWriterOccupancy([warning()], {
      from: "2026-10-13T14:00:58.250Z",
      until: "2026-10-13T14:00:58.750Z",
    });
    expect(waitOnly.operations[0]).toMatchObject({
      reservationMs: 0,
      queueWaitMs: 500,
      maxReservationMs: 0,
    });
    expect(waitOnly.topReservations[0]).toEqual({
      estimatedEnd: "2026-10-13T14:00:58.750Z",
      operation: "session-entry.patch",
      reservationMs: 0,
      queueWaitMs: 500,
    });
    await expect(attributeWriterOccupancy([], { from: "2026-10-13T14:00:00" })).rejects.toThrow(
      "explicit UTC offsets",
    );
    await expect(
      attributeWriterOccupancy([], { from: "2026-10-14T00:00:00Z", until: "2026-10-13T00:00:00Z" }),
    ).rejects.toThrow("increasing");
  });

  it("keeps native transaction phases separate and allowlists nested numeric fields", async () => {
    const nativeWarning = (operation: string, phases: Record<string, unknown>, elapsedMs = 3_415) =>
      JSON.stringify({
        "0": '{"subsystem":"sqlite/transaction"}',
        "2": "slow SQLite transaction hold",
        "1": { operation, elapsedMs, phases, path: "private-path", error: "private-error" },
        _meta: { logLevelName: "WARN" },
        time: "2026-10-13T14:55:38.478Z",
      });
    const native = [
      nativeWarning("session.actor.appendTranscriptEvent", {
        beginMs: 0,
        commitMs: 0,
        hostAdmissionWaitMs: 2_715,
        prepareMs: 3,
        sqlMs: 700,
        privateData: "private-value",
      }),
      nativeWarning(
        "session.actor.appendTranscriptEvent",
        { beginMs: 0, commitMs: 0, hostAdmissionWaitMs: 4, prepareMs: 1, sqlMs: 1_036 },
        1_040,
      ),
      nativeWarning("private-operation", { sqlMs: 5 }, 5),
      nativeWarning("session.actor.patch", { sqlMs: "private-value" }),
    ];
    const report = await attributeWriterOccupancy(native);
    expect(report.observedReservations).toBe(0);
    expect(report.operations).toEqual([]);
    expect(report.nativeTransactions).toEqual([
      {
        operation: "session.actor.appendTranscriptEvent",
        count: 2,
        elapsedMs: 4_455,
        maxElapsedMs: 3_415,
        phases: { beginMs: 0, commitMs: 0, hostAdmissionWaitMs: 2_719, prepareMs: 4, sqlMs: 1_736 },
      },
      { operation: "other", count: 1, elapsedMs: 5, maxElapsedMs: 5, phases: { sqlMs: 5 } },
    ]);
    expect(report.ignoredLines).toBe(1);
    expect(JSON.stringify(report)).not.toContain("private");
    const combined = await attributeWriterOccupancy([warning(), ...native]);
    expect(combined.operations[0]?.reservationMs).toBe(2_000);
    expect(
      (await attributeWriterOccupancy(native, { until: "2026-10-13T14:55:38.478Z" }))
        .nativeTransactions,
    ).toEqual([]);
  });

  it("rejects invalid timing and non-warning schemas and never emits private payload fields", async () => {
    const privateValue = "private-session-token-and-path";
    const report = await attributeWriterOccupancy([
      "not JSON: " + privateValue,
      "null",
      warning({ queueWaitMs: -1 }),
      warning({ writerExecutionMs: "2000" }),
      warning({ elapsedMs: 100 }),
      warning({ completionDelayMs: null }),
      warning({ reentrant: undefined }),
      warning({ pid: undefined }),
      warning({}, "2026-10-13T14:01:01.500"),
      warning().replace('"WARN"', '"INFO"'),
      warning({
        operation: privateValue,
        storePath: privateValue,
        error: privateValue,
        agentId: privateValue,
      }),
    ]);
    expect(report.observedReservations).toBe(1);
    expect(report.ignoredLines).toBe(10);
    expect(report.operations[0]?.operation).toBe("other");
    expect(JSON.stringify(report)).not.toContain(privateValue);
    expect(JSON.stringify(report)).not.toMatch(/"(?:pid|threadId|scope|storePath|agentId|error)":/);
  });
});
