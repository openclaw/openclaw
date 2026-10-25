// Diagnostic memory tests cover pressure events and diagnostic log output.
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import * as workerMemory from "../infra/worker-cpu.js";
import * as workerMessages from "../infra/worker-message-metrics.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  emitDiagnosticMemorySample,
  createDiagnosticMemorySampler,
  resetDiagnosticMemoryForTest,
} from "./diagnostic-memory.js";
import {
  readLatestDiagnosticStabilityBundleSync,
  uninstallDiagnosticStabilityFatalHook,
} from "./diagnostic-stability-bundle.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
import { resetLogger, setLoggerOverride } from "./logger.js";

const flushDiagnosticEvents = () => vi.runAllTimersAsync();

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

const emptyWorkers = {
  workerCount: 0,
  postgresBridgeCount: 0,
  workerHeapSampledCount: 0,
  workerHeapTotalBytes: 0,
  workerHeapUsedBytes: 0,
  workerExternalBytes: 0,
  workerArrayBuffersBytes: 0,
  workerArrayBuffersSampledCount: 0,
  workerMemoryScope: "direct" as const,
  workerMemoryCoverage: "complete" as const,
  workerMemoryMissing: [],
  workerHeaps: [],
  workerTaskMetrics: [],
  workerLifecycle: [],
};
const rssThresholds = { rssWarningBytes: 1000, rssCriticalBytes: 3000, pressureRepeatMs: 60_000 };
function expectedPressure(reason: string, limitBytes: number, includeUsed = false) {
  return ([0.8, 0.9] as const).map((ratio, index) =>
    expect.objectContaining({
      level: index === 0 ? "warning" : "critical",
      reason,
      limitBytes,
      thresholdBytes: Math.floor(limitBytes * ratio),
      ...(includeUsed ? { usedBytes: Math.floor(limitBytes * ratio) } : {}),
    }),
  );
}

describe("diagnostic memory", () => {
  let events: DiagnosticEventPayload[];
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
    resetDiagnosticEventsForTest();
    events = [];
    stop = onDiagnosticEvent((event) => events.push(event));
    resetDiagnosticMemoryForTest();
    uninstallDiagnosticStabilityFatalHook();
    resetDiagnosticStabilityRecorderForTest();
    resetLogger();
    vi.spyOn(workerMessages, "getWorkerMessageMetrics").mockReturnValue([]);
    // Cumulative Worker history survives earlier test files even when no Worker remains alive.
    vi.spyOn(workerMemory, "sampleTrackedWorkerMemory").mockReturnValue(
      structuredClone(emptyWorkers),
    );
  });

  afterEach(() => {
    stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stopDiagnosticStabilityRecorder();
    vi.useRealTimers();
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    uninstallDiagnosticStabilityFatalHook();
    resetDiagnosticStabilityRecorderForTest();
    setLoggerOverride(null);
    resetLogger();
  });

  it("publishes Linux anonymous pages in bytes and omits unavailable later samples", async () => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
    const readFile = vi
      .spyOn(fs, "readFile")
      .mockResolvedValue("Name:\topenclaw\nVmRSS:\t9000 kB\nRssAnon:\t1234 kB\nVmSwap:\t0 kB\n");
    const sampleMemory = createDiagnosticMemorySampler(() => true);
    sampleMemory(true);
    await flushDiagnosticEvents();
    expect(events[0]).toMatchObject({
      type: "diagnostic.memory.sample",
      memory: { anonymousRssBytes: 1_263_616, anonymousSwapBytes: 0 },
    });

    for (const result of ["unreadable", "Name:\topenclaw\nRssAnon:\tunknown kB\n"]) {
      if (result === "unreadable") {
        readFile.mockRejectedValueOnce(new Error("proc unavailable"));
      } else {
        readFile.mockResolvedValueOnce(result);
      }
      events.length = 0;
      sampleMemory(true);
      await flushDiagnosticEvents();
      const sample = events.find((event) => event.type === "diagnostic.memory.sample");
      expect(sample).toBeDefined();
      expect(sample?.memory).not.toHaveProperty("anonymousRssBytes");
      expect(sample?.memory).not.toHaveProperty("anonymousSwapBytes");
    }
  });

  it.each(["resolved", "rejected"])(
    "preserves worker acquisition age when a delayed proc read is %s",
    async (outcome) => {
      vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
      vi.spyOn(process, "memoryUsage").mockReturnValue(memoryUsage({}));
      vi.spyOn(process, "uptime").mockReturnValue(12.5);
      const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
      const worker = {
        script: "sqlite-store.worker.js",
        threadId: 1,
        heapUsed: 40,
        heapTotal: 80,
        sampleAgeMs: 42_000,
      };
      const sampleWorkers = vi.mocked(workerMemory.sampleTrackedWorkerMemory);
      sampleWorkers.mockReturnValue({
        ...sampleWorkers(),
        workerCount: 1,
        workerHeapSampledCount: 1,
        workerHeapUsedBytes: 40,
        workerHeapTotalBytes: 80,
        workerMemoryCoverage: "partial",
        workerHeaps: [worker],
      });
      sampleWorkers.mockClear();
      const pending = Promise.withResolvers<string>();
      const readFile = vi.spyOn(fs, "readFile").mockReturnValue(pending.promise);
      startDiagnosticStabilityRecorder();
      createDiagnosticMemorySampler(() => true)(true);
      expect(events).toEqual([]);
      clock.mockReturnValue(1750);
      vi.setSystemTime(new Date("2026-04-22T11:00:00.000Z"));
      if (outcome === "resolved") {
        pending.resolve("RssAnon:\t1234 kB\n");
      } else {
        pending.reject(new Error("proc unavailable"));
      }
      await flushDiagnosticEvents();
      const sample = {
        type: "diagnostic.memory.sample",
        ts: Date.now(),
        memory: { workerHeaps: [{ ...worker, sampleAgeMs: 42_750 }] },
      };
      expect(events).toMatchObject([{ ...sample, uptimeMs: 12_500 }]);
      expect(getDiagnosticStabilitySnapshot().events).toMatchObject([sample]);
      expect(worker.sampleAgeMs).toBe(42_000);
      expect(sampleWorkers).toHaveBeenCalledTimes(1);
      expect(readFile).toHaveBeenCalledTimes(1);
    },
  );

  it("skips proc off Linux and discards a sample after its heartbeat retires", async () => {
    const readFile = vi.spyOn(fs, "readFile").mockResolvedValue("RssAnon:\t1234 kB\n");
    let current = true;
    const sampleMemory = createDiagnosticMemorySampler(() => current);
    vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
    sampleMemory(true);
    expect(readFile).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: "diagnostic.memory.sample" });

    vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
    events.length = 0;
    sampleMemory(false);
    expect(readFile).not.toHaveBeenCalled();
    sampleMemory(true);
    current = false;
    await flushDiagnosticEvents();
    expect(events).toEqual([]);
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
      sample({ ...options, heapSizeLimitBytes: 0 });
      expect(getHeapStatistics).not.toHaveBeenCalled();

      sample(options);
      expect(getHeapStatistics).toHaveBeenCalledTimes(1);
      expect(getHeapSpaceStatistics).not.toHaveBeenCalled();
      sample({ ...options, emitSample: true });
      expect(getHeapSpaceStatistics).toHaveBeenCalledTimes(process.versions.bun ? 0 : 1);
      sample({ ...options, heapSizeLimitBytes: 8 * 1024 ** 3 });
      sample(options);
      expect(getHeapStatistics).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("node:v8");
      vi.resetModules();
    }
  });

  it.each([
    ["main heap critical before RSS critical", 3000, 2000, "critical"],
    ["main heap warning before RSS warning", 1000, 500, "warning"],
    ["no pressure below all thresholds", 999, 499, null],
  ] as const)("selects %s at inclusive boundaries", (_name, rss, heapUsed, level) => {
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
    expect(memory).toMatchObject({
      rssBytes: rss,
      heapUsedBytes: heapUsed,
      heapTotalBytes: 80,
      externalBytes: 10,
      arrayBuffersBytes: 5,
    });

    expect(events).toEqual(
      level
        ? [
            expect.objectContaining({
              type: "diagnostic.memory.pressure",
              level,
              reason: "heap_threshold",
              thresholdBytes: level === "critical" ? 2000 : 500,
              memory,
            }),
          ]
        : [],
    );
  });

  it("keeps rss_threshold retirement silent without consuming the report throttle", async () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    const internalEvents: DiagnosticEventPayload[] = [];
    const stopInternal = onInternalDiagnosticEvent((event) => internalEvents.push(event));
    const pressure = channel("openclaw.memory.critical");
    const retireIdle = vi.fn();
    pressure.subscribe(retireIdle);
    const thresholds = {
      rssWarningBytes: 10_000,
      rssCriticalBytes: 3000,
      pressureRepeatMs: 60_000,
    };
    try {
      for (const now of [1000, 6000]) {
        emitDiagnosticMemorySample(
          { now, memoryUsage: memoryUsage({ rss: 4000 }), thresholds },
          false,
        );
      }
      await flushDiagnosticEvents();
      expect(retireIdle).toHaveBeenCalledTimes(2);
      expect(workerMemory.sampleTrackedWorkerMemory).not.toHaveBeenCalled();
      expect(workerMessages.getWorkerMessageMetrics).not.toHaveBeenCalled();
      expect(internalEvents).toEqual([]);

      // Silent samples must not suppress the first diagnostic warning after re-enable.
      for (const now of [11_000, 16_000]) {
        emitDiagnosticMemorySample({
          now,
          memoryUsage: memoryUsage({ rss: 4000 }),
          thresholds,
        });
      }
      await flushDiagnosticEvents();
      expect(retireIdle).toHaveBeenCalledTimes(4);
      expect(internalEvents.filter((event) => event.type === "diagnostic.memory.pressure")).toEqual(
        [expect.objectContaining({ level: "critical", reason: "rss_threshold" })],
      );
      expect(internalEvents.filter((event) => event.type === "log.record")).toEqual([
        expect.objectContaining({
          level: "WARN",
          message: expect.stringContaining("memory pressure: level=critical reason=rss_threshold"),
          attributes: expect.objectContaining({ subsystem: "gateway/diagnostics/memory" }),
        }),
      ]);
    } finally {
      pressure.unsubscribe(retireIdle);
      stopInternal();
    }
  });

  it("measures main heap pressure against its V8 limit", () => {
    const limitBytes = 1024 ** 3;
    for (const [index, ratio] of [0.5, 0.8, 0.9].entries()) {
      emitDiagnosticMemorySample({
        now: index * 1000,
        emitSample: false,
        isBunRuntime: false,
        heapSizeLimitBytes: limitBytes,
        memoryUsage: memoryUsage({ heapUsed: Math.floor(limitBytes * ratio) }),
      });
    }
    expect(events).toEqual(expectedPressure("heap_threshold", limitBytes, true));
  });

  it.each([
    ["cgroup", 4, 64, 4],
    ["host", 0, 32, 32],
    ["invalid constraint", Number.NaN, 4, 4],
  ] as const)(
    "measures RSS against %s capacity independently of V8",
    (_name, constraint, host, limitGiB) => {
      const gb = 1024 ** 3;
      const limitBytes = limitGiB * gb;
      for (const [index, ratio] of [0.5, 0.8, 0.9].entries()) {
        emitDiagnosticMemorySample({
          now: index * 1000,
          emitSample: false,
          heapSizeLimitBytes: gb,
          processMemoryLimitBytes: constraint * gb,
          physicalMemoryBytes: host * gb,
          memoryUsage: memoryUsage({ rss: Math.floor(limitBytes * ratio) }),
        });
      }
      expect(events).toEqual(expectedPressure("rss_threshold", limitBytes));
    },
  );

  it.each([0, Number.POSITIVE_INFINITY])(
    "does not invent byte limits when capacity is %s",
    (limit) => {
      emitDiagnosticMemorySample({
        emitSample: false,
        heapSizeLimitBytes: limit,
        processMemoryLimitBytes: limit,
        physicalMemoryBytes: limit,
        memoryUsage: memoryUsage({ rss: 6 * 1024 ** 3, heapUsed: 3 * 1024 ** 3 }),
      });
      expect(events).toEqual([]);
    },
  );

  it("uses host capacity on Bun without treating compatibility heap metadata as a limit", () => {
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
    emitDiagnosticMemorySample({
      emitSample: false,
      memoryUsage: memoryUsage({}),
      heapSizeLimitBytes: 16_000,
    });
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

  it("does not write bundles when critical pressure is emitted", async () => {
    const state = await createOpenClawTestState({ label: "memory-pressure" });
    try {
      startDiagnosticStabilityRecorder();
      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: rssThresholds,
      });
      expect(readLatestDiagnosticStabilityBundleSync({ stateDir: state.stateDir }).status).toBe(
        "missing",
      );
    } finally {
      await state.cleanup();
    }
  });

  it("logs warning pressure with readable units and operator guidance", async () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    const records: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const stopInternal = onInternalDiagnosticEvent((event) => {
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
      stopInternal();
    }

    expect(records).toContainEqual(
      expect.objectContaining({
        level: "WARN",
        message: expect.stringContaining(
          "memory pressure: level=warning reason=rss_threshold rss=1.87 GiB heap=1.22 GiB threshold=1.5 GiB thresholdRatio=125%",
        ),
        attributes: expect.objectContaining({ subsystem: "gateway/diagnostics/memory" }),
      }),
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
