// Diagnostic memory tests cover pressure events and diagnostic log output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import * as workerMemory from "../infra/worker-cpu.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";
import { uninstallDiagnosticStabilityFatalHook } from "./diagnostic-stability-bundle.js";
import {
  resetDiagnosticStabilityRecorderForTest,
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

      const options = {
        memoryUsage: memoryUsage({}),
        emitSample: false,
        isBunRuntime: false,
      };
      sample({ ...options, isBunRuntime: true });
      expect(getHeapStatistics).not.toHaveBeenCalled();
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

  it.each([0])("does not invent byte limits when capacity is %s", (limit) => {
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
      "nextStep=run openclaw gateway diagnostics export, inspect an existing bundle with openclaw gateway stability --bundle latest, or sample allocations with openclaw gateway call diagnostics.heapProfile --timeout 30000.",
    );
  });
});
