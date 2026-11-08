import { describe, expect, it } from "vitest";
import { attributeWriterOccupancy } from "../../scripts/diagnostic-writer-occupancy.mts";

const patchOperation = "session-entry.patch";
const at = (time: string) => `2026-10-13T${time}`;
const timing = (reservationMs: number, queueWaitMs: number) => ({
  operation: patchOperation,
  reservationMs,
  queueWaitMs,
});
const reservation = (estimatedEnd: string, reservationMs: number, queueWaitMs: number) => ({
  estimatedEnd,
  ...timing(reservationMs, queueWaitMs),
});
const minute = (time: string, overlap: number, reservationMs: number, queueWaitMs: number) => ({
  minute: at(`${time}Z`),
  maxObservedWaitOverlap: overlap,
  operations: [timing(reservationMs, queueWaitMs)],
});

function warning(
  fields: Record<string, unknown> = {},
  time = "2026-10-13T14:01:01.500Z",
  message = "slow SQLite session write",
) {
  return JSON.stringify({
    "1": {
      operation: patchOperation,
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
    expect(report).toMatchObject({
      observedReservations: 1,
      ignoredLines: 3,
      operations: [{ ...timing(2_000, 1_000), count: 1, maxReservationMs: 2_000 }],
      minutes: [minute("14:00:00.000", 1, 1_000, 1_000), minute("14:01:00.000", 0, 1_000, 0)],
      topReservations: [reservation("2026-10-13T14:01:01.000Z", 2_000, 1_000)],
    });
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
    expect(report).toMatchObject({
      observedReservations: 5,
      minutes: [{ maxObservedWaitOverlap: 2 }, { maxObservedWaitOverlap: 0 }],
    });
    expect(report.operations.find((row) => row.operation === "direct")?.reservationMs).toBe(2_000);
  });

  it("clips intervals using offset-qualified bounds, including warnings emitted after the window", async () => {
    for (const [from, until, end, held, waited, minutes] of [
      ["07:00:59.500-07:00", "14:01:00.500+00:00", "14:01:00.500", 1_000, 0, [500, 500]],
      ["14:00:58.250Z", "14:00:58.750Z", "14:00:58.750", 0, 500, [0]],
    ] as const) {
      const report = await attributeWriterOccupancy([warning()], {
        from: at(from),
        until: at(until),
      });
      expect(report.operations[0]).toMatchObject({
        reservationMs: held,
        queueWaitMs: waited,
        maxReservationMs: held,
      });
      expect(report.minutes.map((row) => row.operations[0]?.reservationMs)).toEqual(minutes);
      expect(report.topReservations).toEqual([reservation(at(`${end}Z`), held, waited)]);
    }
    await expect(attributeWriterOccupancy([], { from: "2026-10-13T14:00:00" })).rejects.toThrow(
      "explicit UTC offsets",
    );
    await expect(
      attributeWriterOccupancy([], { from: "2026-10-14T00:00:00Z", until: "2026-10-13T00:00:00Z" }),
    ).rejects.toThrow("increasing");
  });

  it("keeps native transaction phases separate and allowlists nested numeric fields", async () => {
    const append = "session.actor.appendTranscriptEvent";
    const nativeWarning = (
      values: Record<string, unknown>,
      elapsedMs = 3_415,
      operation = append,
    ) =>
      JSON.stringify({
        "2": "slow SQLite transaction hold",
        "1": { operation, elapsedMs, phases: values, path: "private-path", error: "private-error" },
        _meta: { logLevelName: "WARN" },
        time: "2026-10-13T14:55:38.478Z",
      });
    const native = [
      nativeWarning({
        hostAdmissionWaitMs: 2_015,
        databaseAdmissionWaitMs: 700,
        sqlMs: 700,
        privateData: "private-value",
      }),
      nativeWarning({ hostAdmissionWaitMs: 4, databaseAdmissionWaitMs: 6, sqlMs: 1_030 }, 1_040),
      nativeWarning({ sqlMs: 5 }, 5, "private-operation"),
      nativeWarning({ databaseAdmissionWaitMs: 0 }, 0, "session.actor.patch"),
      nativeWarning({ sqlMs: "private-value" }, undefined, "session.actor.patch"),
    ];
    const report = await attributeWriterOccupancy(native);
    expect(report).toMatchObject({ observedReservations: 0, operations: [], ignoredLines: 1 });
    expect(report.nativeTransactions).toEqual([
      {
        operation: append,
        count: 2,
        elapsedMs: 4_455,
        maxElapsedMs: 3_415,
        phases: { hostAdmissionWaitMs: 2_019, databaseAdmissionWaitMs: 706, sqlMs: 1_730 },
      },
      { operation: "other", count: 1, elapsedMs: 5, maxElapsedMs: 5, phases: { sqlMs: 5 } },
      {
        operation: "session.actor.patch",
        count: 1,
        elapsedMs: 0,
        maxElapsedMs: 0,
        phases: { databaseAdmissionWaitMs: 0 },
      },
    ]);
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
    expect(report).toMatchObject({
      observedReservations: 1,
      ignoredLines: 10,
      operations: [{ operation: "other" }],
    });
    expect(JSON.stringify(report)).not.toContain(privateValue);
    expect(JSON.stringify(report)).not.toMatch(/"(?:pid|threadId|scope|storePath|agentId|error)":/);
  });
});
