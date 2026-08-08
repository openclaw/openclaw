// Diagnostic memory tests cover memory snapshot capture and diagnostic log output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";
import {
  readLatestDiagnosticStabilityBundleSync,
  resetDiagnosticStabilityBundleForTest,
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

describe("diagnostic memory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    resetDiagnosticStabilityBundleForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetLogger();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    vi.useRealTimers();
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    resetDiagnosticStabilityBundleForTest();
    resetDiagnosticStabilityRecorderForTest();
    setLoggerOverride(null);
    resetLogger();
  });

  it("emits memory samples with byte counts", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    emitDiagnosticMemorySample({
      now: 1000,
      uptimeMs: 123,
      memoryUsage: memoryUsage({ rss: 4096, heapUsed: 1024 }),
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
          externalBytes: 10,
          heapTotalBytes: 80,
          rssBytes: 4096,
          heapUsedBytes: 1024,
        },
      },
    ]);
  });

  it("emits pressure when RSS crosses a threshold", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    emitDiagnosticMemorySample({
      now: 1000,
      uptimeMs: 0,
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
        uptimeMs: 0,
        memory: {
          arrayBuffersBytes: 5,
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
          externalBytes: 10,
          heapTotalBytes: 80,
          heapUsedBytes: 40,
          rssBytes: 2000,
        },
      },
    ]);
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

  it("scales default heap pressure thresholds with enlarged V8 limits", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const gb = 1024 ** 3;

    emitDiagnosticMemorySample({
      now: 1000,
      heapSizeLimitBytes: 8 * gb,
      memoryUsage: memoryUsage({ heapUsed: 2.1 * gb }),
    });
    expect(events.filter((event) => event.type === "diagnostic.memory.pressure")).toEqual([]);

    emitDiagnosticMemorySample({
      now: 2000,
      heapSizeLimitBytes: 8 * gb,
      memoryUsage: memoryUsage({ heapUsed: 4.1 * gb }),
    });
    emitDiagnosticMemorySample({
      now: 3000,
      heapSizeLimitBytes: 8 * gb,
      memoryUsage: memoryUsage({ heapUsed: 6.1 * gb }),
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
      { level: "warning", reason: "heap_threshold", threshold: 4 * gb },
      { level: "critical", reason: "heap_threshold", threshold: 6 * gb },
    ]);
  });

  it("scales default RSS pressure thresholds with enlarged V8 limits", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const gb = 1024 ** 3;

    // A gateway sized for an 8 GiB heap routinely holds ~2 GiB RSS. That is its
    // configured working set, not pressure, so it must stay silent.
    emitDiagnosticMemorySample({
      now: 1000,
      heapSizeLimitBytes: 8 * gb,
      memoryLimitBytes: 32 * gb,
      memoryUsage: memoryUsage({ rss: 2.2 * gb, heapUsed: 512 * 1024 * 1024 }),
    });
    expect(events.filter((event) => event.type === "diagnostic.memory.pressure")).toEqual([]);

    emitDiagnosticMemorySample({
      now: 2000,
      heapSizeLimitBytes: 8 * gb,
      memoryLimitBytes: 32 * gb,
      memoryUsage: memoryUsage({ rss: 6.1 * gb, heapUsed: 512 * 1024 * 1024 }),
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
    ).toEqual([{ level: "warning", reason: "rss_threshold", threshold: 6 * gb }]);
  });

  it("keeps previous RSS thresholds on hosts with a small heap limit", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const mb = 1024 * 1024;

    // 2 GiB heap limit * 0.75 == the historical 1536 MiB floor, so small hosts
    // must warn at exactly the same point they did before scaling existed.
    emitDiagnosticMemorySample({
      now: 1000,
      heapSizeLimitBytes: 2048 * mb,
      memoryLimitBytes: 4 * 1024 * mb,
      memoryUsage: memoryUsage({ rss: 1600 * mb, heapUsed: 128 * mb }),
    });
    stop();

    expect(
      events
        .filter((event) => event.type === "diagnostic.memory.pressure")
        .map((event) => ({ reason: event.reason, threshold: event.thresholdBytes })),
    ).toEqual([{ reason: "rss_threshold", threshold: 1536 * mb }]);
  });

  it("rejects an oversized cgroup limit through the default resolver path", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const gb = 1024 ** 3;

    // cgroup reports an effectively unlimited quota as an oversized finite
    // value, not 0 or Infinity. Drive the real resolver (no memoryLimitBytes)
    // with both OS inputs injected, mirroring gateway-heap.ts. On an 8 GiB host
    // the sentinel must be rejected and physical memory used: warning caps at
    // 4 GiB. Trusting the sentinel would leave the 6 GiB maximum, which this
    // host can never reach.
    emitDiagnosticMemorySample({
      now: 1000,
      heapSizeLimitBytes: 8 * gb,
      constrainedMemoryBytes: Number.MAX_SAFE_INTEGER,
      physicalMemoryBytes: 8 * gb,
      // Between the 4 GiB warning and the 6 GiB critical: high enough to warn
      // on an 8 GiB host, low enough that trusting the sentinel would emit
      // nothing at all.
      memoryUsage: memoryUsage({ rss: 4.5 * gb, heapUsed: 256 * 1024 * 1024 }),
    });
    stop();

    const thresholds = events
      .filter((event) => event.type === "diagnostic.memory.pressure")
      .map((event) => event.thresholdBytes);
    expect(thresholds).toContain(4 * gb);
    expect(thresholds).not.toContain(6 * gb);
  });

  it("uses a genuine cgroup limit below physical memory", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const gb = 1024 ** 3;

    // The other side of the boundary: a real constraint must be honored, not
    // discarded in favor of physical memory.
    emitDiagnosticMemorySample({
      now: 1000,
      heapSizeLimitBytes: 8 * gb,
      constrainedMemoryBytes: 4 * gb,
      physicalMemoryBytes: 32 * gb,
      memoryUsage: memoryUsage({ rss: 2.1 * gb, heapUsed: 256 * 1024 * 1024 }),
    });
    stop();

    expect(
      events
        .filter((event) => event.type === "diagnostic.memory.pressure")
        .map((event) => ({ reason: event.reason, threshold: event.thresholdBytes })),
    ).toEqual([{ reason: "rss_threshold", threshold: 2 * gb }]);
  });

  it("never lowers RSS thresholds below the historical defaults on a small host", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const mb = 1024 * 1024;

    // 2 GiB of usable memory: half of it is 1024 MiB, BELOW the historical
    // 1536 MiB warning default. Capping by memory alone would make this host
    // warn EARLIER than before the scaling existed, which is a regression.
    emitDiagnosticMemorySample({
      now: 1000,
      heapSizeLimitBytes: 2048 * mb,
      memoryLimitBytes: 2048 * mb,
      memoryUsage: memoryUsage({ rss: 1200 * mb, heapUsed: 128 * mb }),
    });
    expect(events.filter((event) => event.type === "diagnostic.memory.pressure")).toEqual([]);

    emitDiagnosticMemorySample({
      now: 2000,
      heapSizeLimitBytes: 2048 * mb,
      memoryLimitBytes: 2048 * mb,
      memoryUsage: memoryUsage({ rss: 1600 * mb, heapUsed: 128 * mb }),
    });
    stop();

    expect(
      events
        .filter((event) => event.type === "diagnostic.memory.pressure")
        .map((event) => ({ reason: event.reason, threshold: event.thresholdBytes })),
    ).toEqual([{ reason: "rss_threshold", threshold: 1536 * mb }]);
  });

  it("bounds scaled RSS thresholds by total host memory", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const gb = 1024 ** 3;

    // A container given an 8 GiB heap limit on 8 GiB of memory must not get a
    // 12 GiB critical threshold it can never reach - it would OOM silently.
    // Thresholds are capped to half / three-quarters of total memory instead.
    emitDiagnosticMemorySample({
      now: 1000,
      heapSizeLimitBytes: 8 * gb,
      memoryLimitBytes: 8 * gb,
      memoryUsage: memoryUsage({ rss: 4.1 * gb, heapUsed: 256 * 1024 * 1024 }),
    });
    emitDiagnosticMemorySample({
      now: 2000,
      heapSizeLimitBytes: 8 * gb,
      memoryLimitBytes: 8 * gb,
      memoryUsage: memoryUsage({ rss: 6.1 * gb, heapUsed: 256 * 1024 * 1024 }),
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
      { level: "warning", reason: "rss_threshold", threshold: 4 * gb },
      { level: "critical", reason: "rss_threshold", threshold: 6 * gb },
    ]);
  });

  it("scales default heap pressure thresholds down for constrained V8 limits", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const mb = 1024 ** 2;

    emitDiagnosticMemorySample({
      now: 1000,
      heapSizeLimitBytes: 1024 * mb,
      memoryUsage: memoryUsage({ heapUsed: 600 * mb }),
    });
    emitDiagnosticMemorySample({
      now: 2000,
      heapSizeLimitBytes: 1024 * mb,
      memoryUsage: memoryUsage({ heapUsed: 800 * mb }),
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
      { level: "warning", reason: "heap_threshold", threshold: 512 * mb },
      { level: "critical", reason: "heap_threshold", threshold: 768 * mb },
    ]);
  });

  it("emits pressure when RSS grows quickly", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    emitDiagnosticMemorySample({
      now: 1000,
      memoryUsage: memoryUsage({ rss: 1000 }),
      thresholds: {
        rssWarningBytes: 10_000,
        heapUsedWarningBytes: 10_000,
        rssGrowthWarningBytes: 500,
        growthWindowMs: 10_000,
      },
    });
    emitDiagnosticMemorySample({
      now: 2000,
      memoryUsage: memoryUsage({ rss: 1700 }),
      thresholds: {
        rssWarningBytes: 10_000,
        heapUsedWarningBytes: 10_000,
        rssGrowthWarningBytes: 500,
        growthWindowMs: 10_000,
      },
    });
    stop();

    expect(events.at(-1)).toEqual({
      seq: 3,
      ts: 1_776_859_200_000,
      trace: undefined,
      type: "diagnostic.memory.pressure",
      level: "warning",
      reason: "rss_growth",
      thresholdBytes: 500,
      rssGrowthBytes: 700,
      windowMs: 1000,
      memory: {
        arrayBuffersBytes: 5,
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

  it("resolves session store paths only for enabled critical bundle writes", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-pressure-lazy-"));
    const resolveSessionStorePaths = vi.fn(() => []);
    try {
      emitDiagnosticMemorySample({
        now: 1000,
        stateDir,
        resolveSessionStorePaths,
        memoryUsage: memoryUsage({ rss: 500 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
        },
      });
      emitDiagnosticMemorySample({
        now: 2000,
        stateDir,
        resolveSessionStorePaths,
        memoryUsage: memoryUsage({ rss: 2000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
        },
      });

      expect(resolveSessionStorePaths).not.toHaveBeenCalled();

      emitDiagnosticMemorySample({
        now: 3000,
        stateDir,
        writeCriticalBundle: true,
        resolveSessionStorePaths,
        memoryUsage: memoryUsage({ rss: 4000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
        },
      });

      expect(resolveSessionStorePaths).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("can disable critical pressure bundle writes", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-pressure-disabled-"));
    const resolveSessionStorePaths = vi.fn(() => []);
    try {
      startDiagnosticStabilityRecorder();

      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        stateDir,
        writeCriticalBundle: false,
        resolveSessionStorePaths,
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });

      expect(resolveSessionStorePaths).not.toHaveBeenCalled();
      expect(readLatestDiagnosticStabilityBundleSync({ stateDir }).status).toBe("missing");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("leaves critical pressure bundle writes off by default", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-memory-pressure-default-off-"),
    );
    const resolveSessionStorePaths = vi.fn(() => []);
    try {
      startDiagnosticStabilityRecorder();

      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        stateDir,
        resolveSessionStorePaths,
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });

      expect(resolveSessionStorePaths).not.toHaveBeenCalled();
      expect(readLatestDiagnosticStabilityBundleSync({ stateDir }).status).toBe("missing");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("logs memory pressure events through the gateway subsystem", async () => {
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

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "WARN",
          message: expect.stringContaining("memory pressure: level=critical reason=rss_threshold"),
          attributes: expect.objectContaining({
            subsystem: "gateway/diagnostics/memory",
          }),
        }),
        expect.objectContaining({
          level: "WARN",
          message: "critical memory pressure snapshot disabled",
          attributes: expect.objectContaining({
            subsystem: "gateway/diagnostics/memory",
          }),
        }),
      ]),
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

  it("writes a stability bundle when critical pressure is emitted", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-pressure-"));
    const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-custom-sessions-"));
    try {
      const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
      const customSessionsDir = path.join(customRoot, "custom-sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(customSessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, "small.jsonl"), "small\n", "utf8");
      fs.writeFileSync(path.join(sessionsDir, "large.jsonl"), "x".repeat(4096), "utf8");
      fs.writeFileSync(path.join(customSessionsDir, "sessions.json"), "{}\n", "utf8");
      fs.writeFileSync(
        path.join(customSessionsDir, "custom-secret-session.jsonl"),
        "x".repeat(8192),
        "utf8",
      );
      startDiagnosticStabilityRecorder();

      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        uptimeMs: 0,
        stateDir,
        writeCriticalBundle: true,
        sessionStorePaths: [path.join(customSessionsDir, "sessions.json")],
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });

      const latest = readLatestDiagnosticStabilityBundleSync({ stateDir });
      expect(latest.status).toBe("found");
      if (latest.status !== "found") {
        return;
      }
      expect(latest.bundle.reason).toBe("diagnostic.memory.pressure.critical");
      expect(latest.bundle.snapshot.summary.byType["diagnostic.memory.pressure"]).toBe(1);
      expect(latest.bundle.evidence?.memoryPressure).toMatchObject({
        level: "critical",
        reason: "rss_threshold",
        thresholdBytes: 3000,
        memory: expect.objectContaining({
          rssBytes: 4000,
          heapUsedBytes: 3000,
        }),
      });
      expect(latest.bundle.evidence?.memoryPressure?.heapStatistics?.heapSizeLimitBytes).toEqual(
        expect.any(Number),
      );
      expect(latest.bundle.evidence?.memoryPressure?.activeResources?.total).toEqual(
        expect.any(Number),
      );
      expect(latest.bundle.evidence?.memoryPressure?.topSessionFiles?.[0]).toMatchObject({
        relativePath: "sessions/<session>.jsonl",
        sizeBytes: 8192,
      });
      expect(JSON.stringify(latest.bundle)).not.toContain("custom-secret-session");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(customRoot, { recursive: true, force: true });
    }
  });
});
