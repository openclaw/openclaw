/**
 * Tests restart trace formatting and persisted restart metadata.
 */
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  collectGatewayProcessMemoryUsageMb,
  createGatewayRestartTraceHandoffEnv,
  finishGatewayRestartTrace,
  formatGatewayPendingCloseSteps,
  measureGatewayCloseStep,
  recordGatewayRestartTraceSpan,
  startGatewayRestartTrace,
} from "./restart-trace.js";

const logInfo = vi.hoisted(() => vi.fn());
// mock-isolation: Capture diagnostics without opening the process-wide log destination.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: logInfo }),
}));

describe("gateway shutdown diagnostics", () => {
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubEnv("OPENCLAW_GATEWAY_RESTART_TRACE", "0");
  });
  afterEach(() => {
    finishGatewayRestartTrace("test.finish");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    logInfo.mockClear();
  });

  it.each([false, true])("reports slow close steps once (trace=%s)", async (trace) => {
    vi.stubEnv("OPENCLAW_GATEWAY_RESTART_TRACE", trace ? "1" : "0");
    startGatewayRestartTrace("restart.signal.received");
    await measureGatewayCloseStep("restart.close.fast", () => {
      clock += 999;
    });
    await measureGatewayCloseStep("restart.close.slow", () => {
      clock += 1_000;
    });
    const messages = logInfo.mock.calls.map(([message]) => String(message));
    const completions = messages.filter(
      (line) => line.includes("restart.close.") && !line.includes(".begin "),
    );
    expect(completions).toEqual(
      trace
        ? [
            "restart trace: restart.close.fast 999.0ms total=999.0ms",
            "restart trace: restart.close.slow 1000.0ms total=1999.0ms",
          ]
        : ["shutdown step restart.close.slow settled after 1000ms"],
    );
    expect(formatGatewayPendingCloseSteps()).toBe("none");
  });

  it("retains concurrent same-name joins until each fulfills or rejects", async () => {
    const first = createDeferredCore();
    const second = createDeferredCore();
    const closingFirst = measureGatewayCloseStep("restart.close.channels", () => first.promise);
    clock = 100;
    const closingSecond = measureGatewayCloseStep("restart.close.channels", () => second.promise);
    try {
      clock = 250;
      expect(formatGatewayPendingCloseSteps()).toBe(
        "restart.close.channels=250ms, restart.close.channels=150ms",
      );
      first.resolve();
      await closingFirst;
      expect(formatGatewayPendingCloseSteps()).toBe("restart.close.channels=150ms");
      const failure = new Error("channel teardown failed");
      const rejected = expect(closingSecond).rejects.toBe(failure);
      second.reject(failure);
      await rejected;
      expect(formatGatewayPendingCloseSteps()).toBe("none");
    } finally {
      first.resolve();
      second.resolve();
      await Promise.allSettled([closingFirst, closingSecond]);
    }
  });

  it("keeps the parent ready duration when recording child spans", () => {
    vi.stubEnv("OPENCLAW_GATEWAY_RESTART_TRACE", "1");
    startGatewayRestartTrace("restart.signal.received");
    clock = 20;
    recordGatewayRestartTraceSpan("restart.ready.runtime.post-attach", 12, 40, [
      ["eventLoopMax", "1.0ms"],
    ]);
    clock = 40;
    finishGatewayRestartTrace("restart.ready");
    expect(logInfo.mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        "restart trace: restart.ready.runtime.post-attach 12.0ms total=40.0ms eventLoopMax=1.0ms",
        "restart trace: restart.ready 40.0ms total=40.0ms",
      ]),
    );
  });

  it("bounds pending diagnostics and keeps step names on one line", async () => {
    const released = createDeferredCore();
    const closing = Array.from({ length: 10 }, (_, index) =>
      measureGatewayCloseStep(`restart.close.${index}\n${"x".repeat(200)}`, () => released.promise),
    );
    try {
      clock = 1_234;
      const summary = formatGatewayPendingCloseSteps();
      expect(summary).toContain("restart.close.0_");
      expect(summary).not.toContain("\n");
      expect(summary).not.toContain("x".repeat(121));
      expect(summary).toContain("=1234ms");
      expect(summary).toMatch(/, \+2 more$/u);
      expect(summary.length).toBeLessThan(1_200);
    } finally {
      released.resolve();
      await Promise.all(closing);
    }
    expect(formatGatewayPendingCloseSteps()).toBe("none");
  });
});

describe("gateway restart trace handoff", () => {
  it("keeps timing for slow but valid drains", () => {
    const startedAt = Date.now() - 305_000;
    const lastAt = startedAt + 300_000;

    expect(
      createGatewayRestartTraceHandoffEnv({
        startedAt,
        lastAt,
      }),
    ).toStrictEqual({
      OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS: String(startedAt),
      OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS: String(lastAt),
    });
  });

  it("includes restart resource counts with ready memory metrics", () => {
    const metrics = Object.fromEntries(collectGatewayProcessMemoryUsageMb());

    expect(metrics.rssMb).toEqual(expect.any(Number));
    expect(metrics.activeTimersCount).toEqual(expect.any(Number));
    expect(metrics.processRestartListenersCount).toEqual(expect.any(Number));
    expect(metrics.processSigtermListenersCount).toEqual(expect.any(Number));
    expect(metrics.processSigintListenersCount).toEqual(expect.any(Number));
  });

  it("counts active timer resources", () => {
    const timer = setTimeout(() => {}, 10_000);
    try {
      const metrics = Object.fromEntries(collectGatewayProcessMemoryUsageMb());

      expect(metrics.activeTimersCount).toBeGreaterThanOrEqual(1);
    } finally {
      clearTimeout(timer);
    }
  });
});
