// Diagnostic memory tests cover pressure events and diagnostic log output.
import { channel } from "node:diagnostics_channel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import * as workerMemory from "../infra/worker-cpu.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";
import {
  readLatestDiagnosticStabilityBundleSync,
  uninstallDiagnosticStabilityFatalHook,
} from "./diagnostic-stability-bundle.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
import { resetLogger, setLoggerOverride } from "./logger.js";

function flushDiagnosticEvents() {
  return vi.runAllTimersAsync();
}

function memoryUsage(overrides: Partial<NodeJS.MemoryUsage>): NodeJS.MemoryUsage {
  return {
    rss: 100,
    heapTotal: 80,
    heapUsed: 40,
    external: 10,
    arrayBuffers: 5,
    ...overrides,
  };
}

const workerLifecycle: ReturnType<
  typeof workerMemory.sampleTrackedWorkerMemory
>["workerLifecycle"] = [
  { script: "sqlite-store.worker.js", started: 3, retired: [{ reason: "closed", count: 3 }] },
];

describe("diagnostic memory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    uninstallDiagnosticStabilityFatalHook();
    resetDiagnosticStabilityRecorderForTest();
    resetLogger();
    // Cumulative Worker history survives earlier test files even when no Worker remains alive.
    vi.spyOn(workerMemory, "sampleTrackedWorkerMemory").mockReturnValue({
      workerCount: 0,
      workerHeapSampledCount: 0,
      workerHeapTotalBytes: 0,
      workerHeapUsedBytes: 0,
      workerExternalBytes: 0,
      workerArrayBuffersBytes: 0,
      workerArrayBuffersSampledCount: 0,
      workerMemoryScope: "direct",
      workerMemoryCoverage: "complete",
      workerMemoryMissing: [],
      workerHeaps: [],
      workerLifecycle: structuredClone(workerLifecycle),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stopDiagnosticStabilityRecorder();
    vi.useRealTimers();
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    uninstallDiagnosticStabilityFatalHook();
    resetDiagnosticStabilityRecorderForTest();
    setLoggerOverride(null);
    resetLogger();
  });

  it("emits pressure when RSS crosses a threshold", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    emitDiagnosticMemorySample({
      now: 1000,
      uptimeMs: 123,
      isBunRuntime: true,
      heapSizeLimitBytes: 280_657_920,
      processMemoryLimitBytes: 512 * 1024 ** 3,
      memoryUsage: memoryUsage({ rss: 2000 }),
      thresholds: {
        rssWarningBytes: 1000,
        rssCriticalBytes: 3000,
        pressureRepeatMs: 60_000,
      },
    });
    stop();

    expect(events).toEqual([
      {
        seq: 1,
        ts: 1_776_859_200_000,
        trace: undefined,
        type: "diagnostic.memory.sample",
        uptimeMs: 123,
        memory: {
          arrayBuffersBytes: 5,
          workerCount: 0,
          workerHeapSampledCount: 0,
          workerHeapTotalBytes: 0,
          workerHeapUsedBytes: 0,
          workerExternalBytes: 0,
          workerArrayBuffersBytes: 0,
          workerArrayBuffersSampledCount: 0,
          workerMemoryScope: "direct",
          workerMemoryCoverage: "complete",
          workerMemoryMissing: [],
          workerHeaps: [],
          workerLifecycle,
          externalBytes: 10,
          heapTotalBytes: 80,
          heapUsedBytes: 40,
          rssBytes: 2000,
        },
      },
      {
        seq: 2,
        ts: 1_776_859_200_000,
        trace: undefined,
        type: "diagnostic.memory.pressure",
        level: "warning",
        reason: "rss_threshold",
        thresholdBytes: 1000,
        memory: {
          arrayBuffersBytes: 5,
          workerCount: 0,
          workerHeapSampledCount: 0,
          workerHeapTotalBytes: 0,
          workerHeapUsedBytes: 0,
          workerExternalBytes: 0,
          workerArrayBuffersBytes: 0,
          workerArrayBuffersSampledCount: 0,
          workerMemoryScope: "direct",
          workerMemoryCoverage: "complete",
          workerMemoryMissing: [],
          workerHeaps: [],
          workerLifecycle,
          externalBytes: 10,
          heapTotalBytes: 80,
          heapUsedBytes: 40,
          rssBytes: 2000,
        },
      },
    ]);
  });

  it.each([
    {
      name: "RSS critical before heap critical",
      rss: 3000,
      heapUsed: 2000,
      expected: { level: "critical", reason: "rss_threshold", thresholdBytes: 3000 },
    },
    {
      name: "heap critical before RSS warning",
      rss: 1000,
      heapUsed: 2000,
      expected: { level: "critical", reason: "heap_threshold", thresholdBytes: 2000 },
    },
    {
      name: "RSS warning before heap warning",
      rss: 1000,
      heapUsed: 500,
      expected: { level: "warning", reason: "rss_threshold", thresholdBytes: 1000 },
    },
    {
      name: "heap warning after RSS stays below its threshold",
      rss: 999,
      heapUsed: 500,
      expected: { level: "warning", reason: "heap_threshold", thresholdBytes: 500 },
    },
    { name: "no pressure below all thresholds", rss: 999, heapUsed: 499, expected: null },
  ])("selects $name at inclusive boundaries", ({ rss, heapUsed, expected }) => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    const memory = emitDiagnosticMemorySample({
      now: 1000,
      emitSample: false,
      memoryUsage: memoryUsage({ rss, heapUsed }),
      thresholds: {
        rssCriticalBytes: 3000,
        heapUsedCriticalBytes: 2000,
        rssWarningBytes: 1000,
        heapUsedWarningBytes: 500,
      },
    });
    stop();

    expect(events).toEqual(
      expected
        ? [
            {
              seq: 1,
              ts: 1_776_859_200_000,
              trace: undefined,
              type: "diagnostic.memory.pressure",
              ...expected,
              memory,
            },
          ]
        : [],
    );
  });

  it("can check pressure without recording an idle memory sample", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    emitDiagnosticMemorySample({
      now: 1000,
      emitSample: false,
      memoryUsage: memoryUsage({ rss: 2000 }),
      thresholds: {
        rssWarningBytes: 1000,
        rssCriticalBytes: 3000,
        pressureRepeatMs: 60_000,
      },
    });
    stop();

    expect(events.map((event) => event.type)).toEqual(["diagnostic.memory.pressure"]);
  });

  it("requests idle retirement on every critical sample despite log suppression", () => {
    const pressure = channel("openclaw.memory.critical");
    const retireIdle = vi.fn();
    pressure.subscribe(retireIdle);
    try {
      for (const now of [1_000, 2_000]) {
        emitDiagnosticMemorySample({
          now,
          emitSample: false,
          memoryUsage: memoryUsage({ rss: 4_000 }),
          thresholds: { rssCriticalBytes: 3_000, pressureRepeatMs: 60_000 },
        });
      }
      expect(retireIdle).toHaveBeenCalledTimes(2);
    } finally {
      pressure.unsubscribe(retireIdle);
    }
  });

  it.each([1, 16])("scales default heap pressure thresholds with a %i GiB V8 limit", (heapGiB) => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const gb = 1024 ** 3;

    emitDiagnosticMemorySample({
      now: 1000,
      isBunRuntime: false,
      heapSizeLimitBytes: heapGiB * gb,
      memoryUsage: memoryUsage({ heapUsed: heapGiB * 0.25 * gb }),
    });
    expect(events.filter((event) => event.type === "diagnostic.memory.pressure")).toEqual([]);

    emitDiagnosticMemorySample({
      now: 2000,
      isBunRuntime: false,
      heapSizeLimitBytes: heapGiB * gb,
      memoryUsage: memoryUsage({ heapUsed: heapGiB * 0.51 * gb }),
    });
    emitDiagnosticMemorySample({
      now: 3000,
      isBunRuntime: false,
      heapSizeLimitBytes: heapGiB * gb,
      memoryUsage: memoryUsage({ heapUsed: heapGiB * 0.76 * gb }),
    });
    stop();

    expect(
      events
        .filter((event) => event.type === "diagnostic.memory.pressure")
        .map((event) => ({
          level: event.level,
          reason: event.reason,
          threshold: event.thresholdBytes,
        })),
    ).toEqual([
      { level: "warning", reason: "heap_threshold", threshold: heapGiB * 0.5 * gb },
      { level: "critical", reason: "heap_threshold", threshold: heapGiB * 0.75 * gb },
    ]);
  });

  it.each([
    {
      name: "a 768 MiB default Node heap",
      isBunRuntime: false,
      heapSizeLimitBytes: 432 * 1024 ** 2,
      processMemoryLimitBytes: 768 * 1024 ** 2,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 330 / 1024 }, { rssGiB: 385 / 1024 }, { rssGiB: 577 / 1024 }],
      expectedThresholdsGiB: { warning: 384 / 1024, critical: 576 / 1024 },
    },
    {
      name: "unknown capacity with a small V8 limit",
      isBunRuntime: false,
      heapSizeLimitBytes: 432 * 1024 ** 2,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 0,
      samples: [{ rssGiB: 330 / 1024 }, { rssGiB: 1537 / 1024 }, { rssGiB: 3073 / 1024 }],
      expectedThresholdsGiB: { warning: 1.5, critical: 3 },
    },
    {
      name: "a 16 GiB V8 limit",
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 6.1 }, { rssGiB: 8.1 }, { rssGiB: 12.1 }],
      expectedThresholdsGiB: { warning: 8, critical: 12 },
    },
    {
      name: "a constrained process limit",
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes: 4 * 1024 ** 3,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 1.9 }, { rssGiB: 2.1 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 2, critical: 3 },
    },
    ...[0, Number.NaN].map((processMemoryLimitBytes) => ({
      name: `physical RAM with a ${processMemoryLimitBytes} reported constraint`,
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes,
      physicalMemoryBytes: 4 * 1024 ** 3,
      samples: [{ rssGiB: 1.9 }, { rssGiB: 2.1 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 2, critical: 3 },
    })),
    {
      name: "unknown physical RAM with a valid reported constraint",
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes: 4 * 1024 ** 3,
      physicalMemoryBytes: Number.NaN,
      samples: [{ rssGiB: 1.9 }, { rssGiB: 2.1 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 2, critical: 3 },
    },
    {
      name: "unknown capacity with a valid V8 limit",
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 0,
      samples: [{ rssGiB: 6.1 }, { rssGiB: 8.1 }, { rssGiB: 12.1 }],
      expectedThresholdsGiB: { warning: 8, critical: 12 },
    },
    {
      name: "an unlimited process sentinel",
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes: Number.MAX_SAFE_INTEGER,
      physicalMemoryBytes: 4 * 1024 ** 3,
      samples: [{ rssGiB: 1.9 }, { rssGiB: 2.1 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 2, critical: 3 },
    },
    ...[0, Number.NaN].map((heapSizeLimitBytes) => ({
      name: `unknown capacity with a ${heapSizeLimitBytes} V8 limit`,
      isBunRuntime: false,
      heapSizeLimitBytes,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 0,
      samples: [{ rssGiB: 1.4 }, { rssGiB: 1.6 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 1.5, critical: 3 },
    })),
    {
      name: "Bun compatibility heap statistics",
      isBunRuntime: true,
      heapSizeLimitBytes: 280_657_920,
      processMemoryLimitBytes: 512 * 1024 ** 3,
      physicalMemoryBytes: 512 * 1024 ** 3,
      samples: [{ rssGiB: 500 / 1024, heapUsedMiB: 80 }, { rssGiB: 4.1 }, { rssGiB: 6.1 }],
      expectedThresholdsGiB: { warning: 4, critical: 6 },
    },
    {
      name: "Bun without a process limit",
      isBunRuntime: true,
      heapSizeLimitBytes: 280_657_920,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 512 * 1024 ** 3,
      samples: [{ rssGiB: 1.4 }, { rssGiB: 1.6 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 1.5, critical: 3 },
    },
  ])("scales default RSS pressure thresholds with $name", (testCase) => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const gb = 1024 ** 3;

    for (const [index, sample] of testCase.samples.entries()) {
      const heapUsedMiB =
        "heapUsedMiB" in sample && typeof sample.heapUsedMiB === "number"
          ? sample.heapUsedMiB
          : undefined;
      emitDiagnosticMemorySample({
        now: (index + 1) * 11 * 60 * 1000,
        heapSizeLimitBytes: testCase.heapSizeLimitBytes,
        processMemoryLimitBytes: testCase.processMemoryLimitBytes,
        physicalMemoryBytes: testCase.physicalMemoryBytes,
        isBunRuntime: testCase.isBunRuntime,
        memoryUsage: memoryUsage({
          rss: Math.round(sample.rssGiB * gb),
          ...(heapUsedMiB === undefined ? {} : { heapUsed: Math.round(heapUsedMiB * 1024 ** 2) }),
        }),
      });
    }
    stop();

    expect(
      events
        .filter((event) => event.type === "diagnostic.memory.pressure")
        .map((event) => ({
          level: event.level,
          reason: event.reason,
          threshold: event.thresholdBytes,
        })),
    ).toEqual([
      {
        level: "warning",
        reason: "rss_threshold",
        threshold: testCase.expectedThresholdsGiB.warning * gb,
      },
      {
        level: "critical",
        reason: "rss_threshold",
        threshold: testCase.expectedThresholdsGiB.critical * gb,
      },
    ]);
  });

  it.each([0, Number.NaN])(
    "keeps default heap pressure thresholds with an invalid V8 limit of %s",
    (heapSizeLimitBytes) => {
      const events: DiagnosticEventPayload[] = [];
      const stop = onDiagnosticEvent((event) => events.push(event));
      const gb = 1024 ** 3;

      emitDiagnosticMemorySample({
        now: 11 * 60 * 1000,
        isBunRuntime: false,
        heapSizeLimitBytes,
        processMemoryLimitBytes: 0,
        physicalMemoryBytes: 0,
        memoryUsage: memoryUsage({ rss: 100, heapUsed: 1.1 * gb }),
      });
      emitDiagnosticMemorySample({
        now: 22 * 60 * 1000,
        isBunRuntime: false,
        heapSizeLimitBytes,
        processMemoryLimitBytes: 0,
        physicalMemoryBytes: 0,
        memoryUsage: memoryUsage({ rss: 100, heapUsed: 2.1 * gb }),
      });
      stop();

      expect(
        events
          .filter((event) => event.type === "diagnostic.memory.pressure")
          .map((event) => ({
            level: event.level,
            reason: event.reason,
            threshold: event.thresholdBytes,
          })),
      ).toEqual([
        { level: "warning", reason: "heap_threshold", threshold: gb },
        { level: "critical", reason: "heap_threshold", threshold: 2 * gb },
      ]);
    },
  );

  it("emits pressure when RSS growth persists across windows", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    for (const [index, rss] of [1000, 1350, 1700, 1700].entries()) {
      emitDiagnosticMemorySample({
        now: 1000 + index * 5000,
        memoryUsage: memoryUsage({ rss }),
        thresholds: {
          rssWarningBytes: 10_000,
          heapUsedWarningBytes: 10_000,
          rssGrowthWarningBytes: 500,
          growthWindowMs: 10_000,
        },
      });
    }
    stop();

    expect(events.at(-1)).toEqual({
      seq: 5,
      ts: 1_776_859_200_000,
      trace: undefined,
      type: "diagnostic.memory.pressure",
      level: "warning",
      reason: "rss_growth",
      thresholdBytes: 500,
      rssGrowthBytes: 700,
      windowMs: 10_000,
      memory: {
        arrayBuffersBytes: 5,
        workerCount: 0,
        workerHeapSampledCount: 0,
        workerHeapTotalBytes: 0,
        workerHeapUsedBytes: 0,
        workerExternalBytes: 0,
        workerArrayBuffersBytes: 0,
        workerArrayBuffersSampledCount: 0,
        workerMemoryScope: "direct",
        workerMemoryCoverage: "complete",
        workerMemoryMissing: [],
        workerHeaps: [],
        workerLifecycle,
        externalBytes: 10,
        heapTotalBytes: 80,
        heapUsedBytes: 40,
        rssBytes: 1700,
      },
    });
  });

  it("throttles repeated pressure events by reason and level", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    for (const now of [1000, 2000]) {
      emitDiagnosticMemorySample({
        now,
        memoryUsage: memoryUsage({ rss: 2000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });
    }
    stop();

    expect(
      events.reduce(
        (count, event) => count + (event.type === "diagnostic.memory.pressure" ? 1 : 0),
        0,
      ),
    ).toBe(1);
  });

  it("does not write bundles when critical pressure is emitted", async () => {
    const state = await createOpenClawTestState({ label: "memory-pressure" });
    try {
      startDiagnosticStabilityRecorder();
      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });
      expect(readLatestDiagnosticStabilityBundleSync({ stateDir: state.stateDir }).status).toBe(
        "missing",
      );
    } finally {
      await state.cleanup();
    }
  });

  it("logs memory pressure events through the gateway subsystem", async () => {
    vi.mocked(workerMemory.sampleTrackedWorkerMemory).mockReturnValue({
      workerCount: 7,
      workerHeapSampledCount: 7,
      workerHeapTotalBytes: 5600,
      workerHeapUsedBytes: 2800,
      workerExternalBytes: 8400,
      workerArrayBuffersBytes: 5600,
      workerArrayBuffersSampledCount: 7,
      workerMemoryScope: "direct",
      workerMemoryCoverage: "complete",
      workerMemoryMissing: [],
      workerLifecycle: [],
      workerHeaps: [200, 700, 400, 100, 600, 300, 500].map((heapUsed) => ({
        script: "sqlite-store.worker.js",
        heapUsed,
        heapTotal: heapUsed * 2,
        external: heapUsed * 3,
        arrayBuffers: heapUsed * 2,
      })),
    });
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    const records: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "log.record") {
        records.push(event);
      }
    });
    try {
      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });
      await flushDiagnosticEvents();
    } finally {
      stop();
    }

    expect(records).toEqual([
      expect.objectContaining({
        level: "WARN",
        message: expect.stringContaining("memory pressure: level=critical reason=rss_threshold"),
        attributes: expect.objectContaining({
          subsystem: "gateway/diagnostics/memory",
        }),
      }),
    ]);
    expect(records[0]?.message).not.toMatch(/snapshot/i);
    expect(records[0]?.message).toContain(
      "external/ArrayBuffers are not capped; nested workers are not included",
    );
    expect(records[0]?.message).toContain(
      "rssBytes=4000 heapUsedBytes=3000 externalBytes=10 arrayBuffersBytes=5 workerHeapTotalBytes=5600 workerHeapUsedBytes=2800 workerExternalBytes=8400 workerArrayBuffersBytes=5600 workerCount=7 workerHeapSampledCount=7 workerArrayBuffersSampledCount=7 workerMemoryCoverage=complete workerMemoryScope=direct",
    );
    expect(records[0]?.message).toContain(
      `workerHeaps=${JSON.stringify([
        {
          script: "sqlite-store.worker.js",
          heapUsed: 700,
          heapTotal: 1400,
          external: 2100,
          arrayBuffers: 1400,
        },
        {
          script: "sqlite-store.worker.js",
          heapUsed: 600,
          heapTotal: 1200,
          external: 1800,
          arrayBuffers: 1200,
        },
        {
          script: "sqlite-store.worker.js",
          heapUsed: 500,
          heapTotal: 1000,
          external: 1500,
          arrayBuffers: 1000,
        },
        {
          script: "sqlite-store.worker.js",
          heapUsed: 400,
          heapTotal: 800,
          external: 1200,
          arrayBuffers: 800,
        },
        {
          script: "sqlite-store.worker.js",
          heapUsed: 300,
          heapTotal: 600,
          external: 900,
          arrayBuffers: 600,
        },
      ])} thresholdBytes=3000`,
    );
    expect(records[0]?.message).toContain(
      "nextStep=run openclaw gateway diagnostics export, inspect an existing bundle with openclaw gateway stability --bundle latest, or on Node sample allocations with openclaw gateway call diagnostics.heapProfile --timeout 30000.",
    );
  });

  it("logs warning pressure with readable units and operator guidance", async () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    const records: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "log.record") {
        records.push(event);
      }
    });
    try {
      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        memoryUsage: memoryUsage({ rss: 2_012_905_472, heapUsed: 1_307_038_712 }),
        thresholds: {
          rssWarningBytes: 1_610_612_736,
          rssCriticalBytes: 3_221_225_472,
          pressureRepeatMs: 60_000,
        },
      });
      await flushDiagnosticEvents();
    } finally {
      stop();
    }

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "WARN",
          message: expect.stringContaining(
            "memory pressure: level=warning reason=rss_threshold rss=1.87 GiB heap=1.22 GiB threshold=1.5 GiB thresholdRatio=125%",
          ),
          attributes: expect.objectContaining({
            subsystem: "gateway/diagnostics/memory",
          }),
        }),
      ]),
    );
    expect(records.at(-1)?.message).toContain("rssBytes=2012905472");
    expect(records.at(-1)?.message).toContain("heapUsedBytes=1307038712");
    expect(records.at(-1)?.message).toContain(
      "nextStep=run openclaw gateway status --deep and openclaw gateway diagnostics export; restart gateway if pressure persists",
    );
  });
});
