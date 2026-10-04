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

  it.each<
    [
      name: string,
      heapGiB: number,
      rateMiB: number,
      warningGiB: number,
      criticalGiB: number,
      initialRssMiB: number,
      options?: Parameters<typeof sample>[3],
    ]
  >([
    ["16 GiB heap", 16, 60, 0.64, 1.28, 3.5 * 1024],
    ["32 GiB heap", 32, 120, 1.28, 2.56, 128],
    ["8 GiB process constraint", 32, 60, 0.5, 1, 128, { processMemoryLimitBytes: 8 * GIB }],
    ["8 GiB physical capacity", 32, 60, 0.5, 1, 128, { physicalMemoryBytes: 8 * GIB }],
    [
      "Bun compatibility heap",
      512,
      60,
      0.5,
      1,
      128,
      { processMemoryLimitBytes: 512 * GIB, isBunRuntime: true },
    ],
    ["zero heap limit", 0, 44, 0.5, 1, 128],
    ["NaN heap limit", Number.NaN, 44, 0.5, 1, 128],
  ])(
    "uses growth thresholds for %s",
    (_, heapGiB, rateMiB, warningGiB, criticalGiB, initialRssMiB, options) => {
      for (let minute = 0; minute <= 30; minute += 0.5) {
        sample(minute, (initialRssMiB + minute * rateMiB) * MIB, heapGiB * GIB, options);
      }

      expect(pressures[0]).toMatchObject({
        level: "warning",
        reason: "rss_growth",
        thresholdBytes: Math.floor(warningGiB * GIB),
      });
      expect(pressures.at(-1)).toMatchObject({
        level: "critical",
        reason: "rss_growth",
        thresholdBytes: Math.floor(criticalGiB * GIB),
      });
      if (heapGiB === 16) {
        expect(pressures[0]).toMatchObject({ rssGrowthBytes: 900 * MIB, windowMs: 15 * MINUTE });
        expect(pressures.at(-1)).toMatchObject({
          rssGrowthBytes: 1500 * MIB,
          windowMs: 25 * MINUTE,
        });
        expect(pressures.every((event) => event.reason === "rss_growth")).toBe(true);
      }
    },
  );

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
});
