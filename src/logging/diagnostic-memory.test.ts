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

  it("defers the default heap probe until a sample needs it and then reuses it", async () => {
    vi.resetModules();
    const getHeapStatistics = vi.fn(() => ({ heap_size_limit: 4 * 1024 ** 3 }));
    const getHeapSpaceStatistics = vi.fn(() => []);
    vi.doMock("node:v8", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:v8")>()),
      getHeapStatistics,
      getHeapSpaceStatistics,
    }));
    try {
      const { emitDiagnosticMemorySample: sample } = await import("./diagnostic-memory.js");
      expect(getHeapStatistics).not.toHaveBeenCalled();

      const options = { memoryUsage: memoryUsage({}), emitSample: false };
      for (const heapSizeLimitBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        sample({ ...options, heapSizeLimitBytes });
      }
      expect(getHeapStatistics).not.toHaveBeenCalled();

      sample(options);
      expect(getHeapStatistics).toHaveBeenCalledTimes(1);
      expect(getHeapSpaceStatistics).not.toHaveBeenCalled();
      sample({ ...options, emitSample: true });
      expect(getHeapSpaceStatistics).toHaveBeenCalledTimes(process.versions.bun ? 0 : 1);
      sample(options);
      expect(getHeapSpaceStatistics).toHaveBeenCalledTimes(process.versions.bun ? 0 : 1);
      sample({ ...options, heapSizeLimitBytes: 8 * 1024 ** 3 });
      sample(options);
      expect(getHeapStatistics).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("node:v8");
      vi.resetModules();
    }
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
      physicalMemoryBytes: 512 * 1024 ** 3,
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
          heapSpaces: process.versions.bun ? undefined : expect.any(Array),
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
        limitBytes: 512 * 1024 ** 3,
        usedBytes: 2000,
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
      name: "main heap critical before RSS critical",
      rss: 3000,
      heapUsed: 2000,
      expected: { level: "critical", reason: "heap_threshold", thresholdBytes: 2000 },
    },
    {
      name: "heap critical before RSS warning",
      rss: 1000,
      heapUsed: 2000,
      expected: { level: "critical", reason: "heap_threshold", thresholdBytes: 2000 },
    },
    {
      name: "main heap warning before RSS warning",
      rss: 1000,
      heapUsed: 500,
      expected: { level: "warning", reason: "heap_threshold", thresholdBytes: 500 },
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
            expect.objectContaining({
              type: "diagnostic.memory.pressure",
              ...expected,
              memory,
            }),
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

  it.each([1, 16])("measures main heap pressure against a %i GiB V8 limit", (heapGiB) => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const limitBytes = heapGiB * 1024 ** 3;
    for (const [index, ratio] of [0.5, 0.8, 0.9].entries()) {
      emitDiagnosticMemorySample({
        now: index * 1000,
        emitSample: false,
        isBunRuntime: false,
        heapSizeLimitBytes: limitBytes,
        memoryUsage: memoryUsage({ heapUsed: Math.floor(limitBytes * ratio) }),
      });
    }
    stop();
    expect(events).toEqual([
      expect.objectContaining({
        level: "warning",
        reason: "heap_threshold",
        limitBytes,
        usedBytes: Math.floor(limitBytes * 0.8),
        thresholdBytes: Math.floor(limitBytes * 0.8),
      }),
      expect.objectContaining({
        level: "critical",
        reason: "heap_threshold",
        limitBytes,
        usedBytes: Math.floor(limitBytes * 0.9),
        thresholdBytes: Math.floor(limitBytes * 0.9),
      }),
    ]);
  });

  it.each([
    { name: "cgroup", processMemoryLimitBytes: 4, physicalMemoryBytes: 64, limitGiB: 4 },
    { name: "host", processMemoryLimitBytes: 0, physicalMemoryBytes: 32, limitGiB: 32 },
    { name: "oversized cgroup", processMemoryLimitBytes: 64, physicalMemoryBytes: 4, limitGiB: 4 },
    { name: "unknown host", processMemoryLimitBytes: 4, physicalMemoryBytes: 0, limitGiB: 4 },
    {
      name: "invalid constraint",
      processMemoryLimitBytes: Number.NaN,
      physicalMemoryBytes: 4,
      limitGiB: 4,
    },
    {
      name: "unlimited sentinel",
      processMemoryLimitBytes: Number.MAX_SAFE_INTEGER,
      physicalMemoryBytes: 4,
      limitGiB: 4,
    },
  ])("measures RSS against $name capacity independently of V8", (input) => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const gb = 1024 ** 3;
    const limitBytes = input.limitGiB * gb;
    for (const [index, ratio] of [0.5, 0.8, 0.9].entries()) {
      emitDiagnosticMemorySample({
        now: index * 1000,
        emitSample: false,
        heapSizeLimitBytes: gb,
        processMemoryLimitBytes: input.processMemoryLimitBytes * gb,
        physicalMemoryBytes: input.physicalMemoryBytes * gb,
        memoryUsage: memoryUsage({ rss: Math.floor(limitBytes * ratio) }),
      });
    }
    stop();
    expect(events).toEqual([
      expect.objectContaining({
        level: "warning",
        reason: "rss_threshold",
        limitBytes,
        thresholdBytes: Math.floor(limitBytes * 0.8),
      }),
      expect.objectContaining({
        level: "critical",
        reason: "rss_threshold",
        limitBytes,
        thresholdBytes: Math.floor(limitBytes * 0.9),
      }),
    ]);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not invent byte limits when capacity is %s",
    (limit) => {
      const events: DiagnosticEventPayload[] = [];
      const stop = onDiagnosticEvent((event) => events.push(event));
      emitDiagnosticMemorySample({
        emitSample: false,
        heapSizeLimitBytes: limit,
        processMemoryLimitBytes: limit,
        physicalMemoryBytes: limit,
        memoryUsage: memoryUsage({ rss: 6 * 1024 ** 3, heapUsed: 3 * 1024 ** 3 }),
      });
      stop();
      expect(events).toEqual([]);
    },
  );

  it("uses host capacity on Bun without treating compatibility heap metadata as a limit", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    for (const [index, rssGiB] of [6, 29].entries()) {
      emitDiagnosticMemorySample({
        now: index * 1000,
        emitSample: false,
        isBunRuntime: true,
        heapSizeLimitBytes: 280_657_920,
        processMemoryLimitBytes: 0,
        physicalMemoryBytes: 32 * 1024 ** 3,
        memoryUsage: memoryUsage({ rss: rssGiB * 1024 ** 3, heapUsed: 2 * 1024 ** 3 }),
      });
    }
    stop();
    expect(events).toEqual([
      expect.objectContaining({
        level: "critical",
        reason: "rss_threshold",
        limitBytes: 32 * 1024 ** 3,
      }),
    ]);
  });

  it("detects a small worker near its own limit despite idle main and sibling heaps", () => {
    const sampled = workerMemory.sampleTrackedWorkerMemory();
    vi.mocked(workerMemory.sampleTrackedWorkerMemory).mockReturnValue({
      ...sampled,
      workerCount: 2,
      workerHeaps: [
        { script: "other", threadId: 1, heapUsed: 100, heapTotal: 200, heapSizeLimitBytes: 16_000 },
        {
          script: "sqlite-store.worker.js",
          threadId: 2,
          heapUsed: 900,
          heapTotal: 950,
          heapSizeLimitBytes: 1000,
        },
      ],
    });
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    emitDiagnosticMemorySample({
      emitSample: false,
      memoryUsage: memoryUsage({}),
      heapSizeLimitBytes: 16_000,
    });
    stop();
    expect(events).toEqual([
      expect.objectContaining({
        level: "critical",
        reason: "worker_heap_threshold",
        usedBytes: 900,
        limitBytes: 1000,
        thresholdBytes: 900,
        workerThreadId: 2,
      }),
    ]);
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
        heapSizeLimitBytes: 16 * 1024 ** 3,
        physicalMemoryBytes: 32 * 1024 ** 3,
        processMemoryLimitBytes: 0,
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
    expect(records.at(-1)?.message).toContain("limit=32 GiB used=1.87 GiB");
    expect(records.at(-1)?.message).toContain("limitBytes=34359738368 usedBytes=2012905472");
    expect(records.at(-1)?.message).toContain("rssBytes=2012905472");
    expect(records.at(-1)?.message).toContain("heapUsedBytes=1307038712");
    expect(records.at(-1)?.message).toContain(
      "nextStep=run openclaw gateway status --deep and openclaw gateway diagnostics export; restart gateway if pressure persists",
    );
  });
});
