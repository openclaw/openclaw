import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryThresholds, startMemoryMonitor } from "./server-memory-monitor.js";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, default: { ...original, totalmem: vi.fn() } };
});

describe("resolveMemoryThresholds", () => {
  it("uses system memory percentages when no config is set", () => {
    // 8GB system
    vi.mocked(os.totalmem).mockReturnValue(8 * 1024 * 1024 * 1024);
    const { warnMB, criticalMB } = resolveMemoryThresholds({});
    // 75% of 8192 = 6144, 85% of 8192 = 6963
    expect(warnMB).toBe(6144);
    expect(criticalMB).toBe(6963);
  });

  it("respects explicit config values", () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * 1024 * 1024 * 1024);
    const { warnMB, criticalMB } = resolveMemoryThresholds({
      gateway: { memory: { warnMB: 2048, criticalMB: 3072 } },
    });
    expect(warnMB).toBe(2048);
    expect(criticalMB).toBe(3072);
  });

  it("clamps warn to minimum 512MB", () => {
    vi.mocked(os.totalmem).mockReturnValue(512 * 1024 * 1024); // 512MB system
    const { warnMB } = resolveMemoryThresholds({});
    expect(warnMB).toBeGreaterThanOrEqual(512);
  });

  it("clamps critical to minimum 1024MB", () => {
    vi.mocked(os.totalmem).mockReturnValue(512 * 1024 * 1024);
    const { criticalMB } = resolveMemoryThresholds({});
    expect(criticalMB).toBeGreaterThanOrEqual(1024);
  });

  it("swaps if critical <= warn", () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * 1024 * 1024 * 1024);
    const { warnMB, criticalMB } = resolveMemoryThresholds({
      gateway: { memory: { warnMB: 2048, criticalMB: 1500 } },
    });
    // criticalMB was 1500 (clamped to 1024 minimum = 1500), warnMB was 2048
    // Since critical (1500) <= warn (2048), swap: warn=1500, critical=2048+256=2304
    expect(criticalMB).toBeGreaterThan(warnMB);
  });

  it("ensures critical > warn even when both equal after clamping", () => {
    vi.mocked(os.totalmem).mockReturnValue(8 * 1024 * 1024 * 1024);
    const { warnMB, criticalMB } = resolveMemoryThresholds({
      gateway: { memory: { warnMB: 1024, criticalMB: 1024 } },
    });
    expect(criticalMB).toBeGreaterThan(warnMB);
  });

  it("handles absent gateway config", () => {
    vi.mocked(os.totalmem).mockReturnValue(4 * 1024 * 1024 * 1024);
    const { warnMB, criticalMB } = resolveMemoryThresholds({ gateway: undefined });
    expect(warnMB).toBeGreaterThanOrEqual(512);
    expect(criticalMB).toBeGreaterThan(warnMB);
  });
});

describe("startMemoryMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeLogger() {
    return {
      subsystem: "test",
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
      child: vi.fn(),
    };
  }

  it("logs debug when RSS is below thresholds", () => {
    const log = makeLogger();
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 500 * 1024 * 1024,
      heapTotal: 200 * 1024 * 1024,
      heapUsed: 150 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 5 * 1024 * 1024,
    });
    const onCritical = vi.fn();
    const { interval } = startMemoryMonitor({
      log,
      warnMB: 1536,
      criticalMB: 2048,
      onCritical,
    });

    vi.advanceTimersByTime(60_000);

    expect(log.debug).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(onCritical).not.toHaveBeenCalled();

    clearInterval(interval);
  });

  it("logs warn when RSS exceeds warn threshold but not critical", () => {
    const log = makeLogger();
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 1600 * 1024 * 1024,
      heapTotal: 800 * 1024 * 1024,
      heapUsed: 600 * 1024 * 1024,
      external: 50 * 1024 * 1024,
      arrayBuffers: 20 * 1024 * 1024,
    });
    const onCritical = vi.fn();
    const { interval } = startMemoryMonitor({
      log,
      warnMB: 1536,
      criticalMB: 2048,
      onCritical,
    });

    vi.advanceTimersByTime(60_000);

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
    expect(onCritical).not.toHaveBeenCalled();

    clearInterval(interval);
  });

  it("logs error and calls onCritical when RSS exceeds critical threshold", () => {
    const log = makeLogger();
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 2100 * 1024 * 1024,
      heapTotal: 1500 * 1024 * 1024,
      heapUsed: 1200 * 1024 * 1024,
      external: 100 * 1024 * 1024,
      arrayBuffers: 50 * 1024 * 1024,
    });
    const onCritical = vi.fn();
    const { interval } = startMemoryMonitor({
      log,
      warnMB: 1536,
      criticalMB: 2048,
      onCritical,
    });

    vi.advanceTimersByTime(60_000);

    expect(log.error).toHaveBeenCalledOnce();
    expect(onCritical).toHaveBeenCalledOnce();

    clearInterval(interval);
  });

  it("fires onCritical only once even after multiple intervals", () => {
    const log = makeLogger();
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 2100 * 1024 * 1024,
      heapTotal: 1500 * 1024 * 1024,
      heapUsed: 1200 * 1024 * 1024,
      external: 100 * 1024 * 1024,
      arrayBuffers: 50 * 1024 * 1024,
    });
    const onCritical = vi.fn();
    const { interval } = startMemoryMonitor({
      log,
      warnMB: 1536,
      criticalMB: 2048,
      onCritical,
    });

    // Advance through 3 intervals
    vi.advanceTimersByTime(60_000 * 3);

    expect(onCritical).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledOnce();

    clearInterval(interval);
  });

  it("transitions from debug to warn as memory grows", () => {
    const log = makeLogger();
    const memoryUsageSpy = vi.spyOn(process, "memoryUsage");

    // First check: below warn
    memoryUsageSpy.mockReturnValueOnce({
      rss: 500 * 1024 * 1024,
      heapTotal: 200 * 1024 * 1024,
      heapUsed: 150 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 5 * 1024 * 1024,
    });

    const onCritical = vi.fn();
    const { interval } = startMemoryMonitor({
      log,
      warnMB: 1536,
      criticalMB: 2048,
      onCritical,
    });

    vi.advanceTimersByTime(60_000);
    expect(log.debug).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();

    // Second check: above warn
    memoryUsageSpy.mockReturnValueOnce({
      rss: 1700 * 1024 * 1024,
      heapTotal: 800 * 1024 * 1024,
      heapUsed: 600 * 1024 * 1024,
      external: 50 * 1024 * 1024,
      arrayBuffers: 20 * 1024 * 1024,
    });

    vi.advanceTimersByTime(60_000);
    expect(log.warn).toHaveBeenCalledOnce();

    clearInterval(interval);
  });
});
