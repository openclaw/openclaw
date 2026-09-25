import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticMemoryPressureEvent,
} from "../infra/diagnostic-events.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MINUTE = 60_000;

describe("diagnostic memory growth", () => {
  let pressures: DiagnosticMemoryPressureEvent[];
  let stop: () => void;

  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    pressures = [];
    stop = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.memory.pressure") {
        pressures.push(event);
      }
    });
  });

  afterEach(() => {
    stop();
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
  });

  function sample(
    minute: number,
    rss: number,
    heapSizeLimitBytes = 16 * GIB,
    options: {
      processMemoryLimitBytes?: number;
      physicalMemoryBytes?: number;
      isBunRuntime?: boolean;
    } = {},
  ) {
    emitDiagnosticMemorySample({
      now: minute * MINUTE,
      emitSample: false,
      isBunRuntime: false,
      heapSizeLimitBytes,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 187 * GIB,
      ...options,
      memoryUsage: { rss, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
    });
  }

  it.each([4, 7])(
    "ignores 2 GiB GC oscillations around a flat floor every %i minutes with a 16 GiB heap",
    (cycleMinutes) => {
      for (let minute = 0; minute <= 60; minute += 0.5) {
        const breathing = minute % cycleMinutes < cycleMinutes - 1 ? 2 * GIB : 0;
        sample(minute, 3.5 * GIB + breathing);
      }

      expect(pressures).toEqual([]);
    },
  );

  it("warns then becomes critical for a sustained 60 MiB/min ramp within 30 minutes", () => {
    for (let minute = 0; minute <= 30; minute += 0.5) {
      sample(minute, 3.5 * GIB + minute * 60 * MIB);
    }

    expect(pressures[0]).toMatchObject({
      level: "warning",
      reason: "rss_growth",
      thresholdBytes: Math.floor(0.64 * GIB),
      rssGrowthBytes: 900 * MIB,
      windowMs: 15 * MINUTE,
    });
    expect(pressures.at(-1)).toMatchObject({
      level: "critical",
      reason: "rss_growth",
      thresholdBytes: Math.floor(1.28 * GIB),
      rssGrowthBytes: 1500 * MIB,
      windowMs: 25 * MINUTE,
    });
    expect(pressures.every((event) => event.reason === "rss_growth")).toBe(true);
  });

  it.each([
    { name: "32 GiB heap", heapGiB: 32, rateMiB: 120, warningGiB: 1.28, criticalGiB: 2.56 },
    {
      name: "8 GiB process constraint",
      heapGiB: 32,
      rateMiB: 60,
      warningGiB: 0.5,
      criticalGiB: 1,
      processMemoryLimitBytes: 8 * GIB,
    },
    {
      name: "8 GiB physical capacity",
      heapGiB: 32,
      rateMiB: 60,
      warningGiB: 0.5,
      criticalGiB: 1,
      physicalMemoryBytes: 8 * GIB,
    },
    {
      name: "Bun compatibility heap",
      heapGiB: 512,
      rateMiB: 60,
      warningGiB: 0.5,
      criticalGiB: 1,
      processMemoryLimitBytes: 512 * GIB,
      isBunRuntime: true,
    },
  ])("uses growth thresholds for $name", (testCase) => {
    for (let minute = 0; minute <= 30; minute += 0.5) {
      sample(minute, (128 + minute * testCase.rateMiB) * MIB, testCase.heapGiB * GIB, testCase);
    }

    expect(pressures[0]).toMatchObject({
      level: "warning",
      reason: "rss_growth",
      thresholdBytes: Math.floor(testCase.warningGiB * GIB),
    });
    expect(pressures.at(-1)).toMatchObject({
      level: "critical",
      reason: "rss_growth",
      thresholdBytes: Math.floor(testCase.criticalGiB * GIB),
    });
  });

  it("does not report a rising floor after RSS falls at a window boundary", () => {
    for (let minute = 0; minute < 20; minute += 0.5) {
      sample(minute, 3.5 * GIB + minute * 60 * MIB);
    }
    sample(20, 3.5 * GIB);

    expect(pressures).toEqual([]);
  });

  it.each(["plateau", "gap", "clock rollback"])("forgets growth after a %s", (interruption) => {
    for (let minute = 0; minute <= 30; minute += 0.5) {
      sample(minute, 3.5 * GIB + minute * 60 * MIB);
    }
    expect(pressures.at(-1)?.level).toBe("critical");

    const floor = 3.5 * GIB + 1800 * MIB;
    if (interruption === "plateau") {
      for (let minute = 30.5; minute <= 45; minute += 0.5) {
        sample(minute, floor);
      }
    }
    pressures.length = 0;
    const start = interruption === "clock rollback" ? 0 : 45;
    for (let minute = 0.5; minute <= 30; minute += 0.5) {
      sample(start + minute, floor + minute * 5 * MIB);
    }

    expect(pressures).toEqual([]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps the 512 MiB/1 GiB growth defaults with an unknown heap limit of %s",
    (heapSizeLimitBytes) => {
      for (let minute = 0; minute <= 30; minute += 0.5) {
        sample(minute, (128 + minute * 44) * MIB, heapSizeLimitBytes);
      }

      expect(pressures[0]).toMatchObject({
        level: "warning",
        reason: "rss_growth",
        thresholdBytes: 512 * MIB,
      });
      expect(pressures.at(-1)).toMatchObject({
        level: "critical",
        reason: "rss_growth",
        thresholdBytes: GIB,
      });
    },
  );
});
