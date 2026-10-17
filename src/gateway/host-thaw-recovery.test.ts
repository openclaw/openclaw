import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostThawRecovery } from "./host-thaw-recovery.js";
import { TICK_INTERVAL_MS } from "./server-constants.js";

// Mirrors the module-private threshold contract in host-thaw-recovery.ts.
const HOST_THAW_MIN_FROZEN_MS = 45_000;
const THAW_GAP = TICK_INTERVAL_MS + HOST_THAW_MIN_FROZEN_MS;
const BUSY_MESSAGE = "host thaw channel restart deferred: gateway still has active work";

function createHarness() {
  let nowMs = 0;
  let cpuUsage = { user: 0, system: 0 };
  vi.spyOn(process, "cpuUsage").mockImplementation(() => cpuUsage);
  let admissionClosed = false;
  let restartReason: "active-work" | "admission-closed" | "channel-restart-incomplete" | undefined;
  const deps = {
    nowMs: () => nowMs,
    restartChannelsIfIdle: vi.fn(async () =>
      restartReason === undefined
        ? ({ status: "completed" } as const)
        : ({ status: "retry", reason: restartReason } as const),
    ),
    refreshHealth: vi.fn(async () => {}),
    refreshPresence: vi.fn(),
    resetEventLoopHealth: vi.fn(),
    isAdmissionClosed: () => admissionClosed,
    logger: { info: vi.fn(), error: vi.fn() },
  };
  const recovery = createHostThawRecovery(deps);
  const elapse = (gapMs: number, cpuCoreRatio = 0) => {
    nowMs += gapMs;
    cpuUsage = {
      user: cpuUsage.user + gapMs * 1_000 * cpuCoreRatio * 0.6,
      system: cpuUsage.system + gapMs * 1_000 * cpuCoreRatio * 0.4,
    };
  };
  return {
    deps,
    setAdmissionClosed: (closed: boolean) => {
      admissionClosed = closed;
    },
    setRestartIdle: (idle: boolean) => {
      restartReason = idle ? undefined : "active-work";
    },
    setRestartReason: (reason: typeof restartReason) => {
      restartReason = reason;
    },
    elapse,
    advance: async (gapMs: number, cpuCoreRatio = 0) => {
      elapse(gapMs, cpuCoreRatio);
      await recovery.tick();
    },
  };
}

function expectRecoveryCount(
  harness: ReturnType<typeof createHarness>,
  count: number,
  restarts = count,
  resets = count,
) {
  expect(harness.deps.restartChannelsIfIdle).toHaveBeenCalledTimes(restarts);
  expect(harness.deps.refreshHealth).toHaveBeenCalledTimes(count);
  expect(harness.deps.refreshPresence).toHaveBeenCalledTimes(count);
  expect(harness.deps.resetEventLoopHealth).toHaveBeenCalledTimes(resets);
}

function restartLogs(harness: ReturnType<typeof createHarness>, kind: string) {
  return harness.deps.logger.info.mock.calls.filter(([message]) =>
    message.includes(`restart ${kind}`),
  );
}

describe("host thaw recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([0.5])("does not recover from a CPU-busy gap with ratio %s", async (cpuCoreRatio) => {
    const harness = createHarness();
    await harness.advance(TICK_INTERVAL_MS, 0);
    await harness.advance(THAW_GAP, cpuCoreRatio);
    await harness.advance(TICK_INTERVAL_MS);

    expectRecoveryCount(harness, 0);
    expect(harness.deps.logger.info).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`gap ${THAW_GAP}ms, CPU ratio ${cpuCoreRatio.toFixed(2)}`),
    );

    await harness.advance(THAW_GAP);
    expectRecoveryCount(harness, 1);
  });

  it("excludes slow recovery work from later thaw samples", async () => {
    const harness = createHarness();
    harness.deps.refreshHealth
      .mockImplementationOnce(async () => harness.elapse(HOST_THAW_MIN_FROZEN_MS))
      .mockImplementationOnce(async () => harness.elapse(HOST_THAW_MIN_FROZEN_MS, 1));

    await harness.advance(THAW_GAP);
    expectRecoveryCount(harness, 1);

    await harness.advance(TICK_INTERVAL_MS);
    expectRecoveryCount(harness, 1);

    await harness.advance(THAW_GAP);
    expectRecoveryCount(harness, 2);

    await harness.advance(THAW_GAP);
    expectRecoveryCount(harness, 3);
  });

  it("defers channel restart until active Gateway work settles", async () => {
    const harness = createHarness();
    harness.setRestartIdle(false);

    await harness.advance(THAW_GAP);
    expectRecoveryCount(harness, 1);

    await harness.advance(TICK_INTERVAL_MS);
    expectRecoveryCount(harness, 1, 2);

    harness.setRestartIdle(true);
    await harness.advance(TICK_INTERVAL_MS);

    expectRecoveryCount(harness, 1, 3);
    expect(harness.deps.restartChannelsIfIdle.mock.calls).toEqual([
      ["new-thaw"],
      ["deferred-retry"],
      ["deferred-retry"],
    ]);
    expect(harness.deps.logger.info).toHaveBeenCalledWith(BUSY_MESSAGE);
  });

  it("reports an incomplete channel restart without blaming active work", async () => {
    const harness = createHarness();
    harness.setRestartReason("channel-restart-incomplete");

    await harness.advance(THAW_GAP);

    expect(harness.deps.logger.info).toHaveBeenCalledWith(
      "host thaw channel restart deferred: one or more channel accounts remain pending",
    );
    expect(harness.deps.logger.info).not.toHaveBeenCalledWith(BUSY_MESSAGE);
  });

  it("abandons busy retries after ten minutes, logging deferral and abandonment once", async () => {
    const harness = createHarness();
    harness.setRestartIdle(false);
    await harness.advance(THAW_GAP);

    for (let elapsedMs = TICK_INTERVAL_MS; elapsedMs < 10 * 60_000; elapsedMs += TICK_INTERVAL_MS) {
      await harness.advance(TICK_INTERVAL_MS);
    }
    expect(harness.deps.restartChannelsIfIdle).toHaveBeenCalledTimes(20);

    await harness.advance(TICK_INTERVAL_MS);
    harness.setRestartIdle(true);
    await harness.advance(TICK_INTERVAL_MS);
    expect(harness.deps.restartChannelsIfIdle).toHaveBeenCalledTimes(20);
    expect(restartLogs(harness, "deferred")).toEqual([[BUSY_MESSAGE]]);
    expect(restartLogs(harness, "abandoned")).toEqual([
      [expect.stringContaining("gateway stayed busy")],
    ]);

    await harness.advance(THAW_GAP);
    expect(harness.deps.restartChannelsIfIdle).toHaveBeenCalledTimes(21);
  });

  it("does not renew the restart window while admission stays closed", async () => {
    const harness = createHarness();
    harness.setAdmissionClosed(true);
    await harness.advance(THAW_GAP);
    for (let elapsedMs = 0; elapsedMs < 10 * 60_000; elapsedMs += TICK_INTERVAL_MS) {
      await harness.advance(TICK_INTERVAL_MS);
    }
    harness.setAdmissionClosed(false);
    await harness.advance(TICK_INTERVAL_MS);

    expect(harness.deps.restartChannelsIfIdle).not.toHaveBeenCalled();
    expect(harness.deps.refreshHealth).toHaveBeenCalledOnce();
    expect(harness.deps.refreshPresence).toHaveBeenCalledOnce();
    expect(restartLogs(harness, "abandoned")).toHaveLength(1);
  });

  it("defers a detected thaw until admission reopens and recovers once", async () => {
    const harness = createHarness();
    harness.setAdmissionClosed(true);

    await harness.advance(THAW_GAP);
    expectRecoveryCount(harness, 0);

    harness.setAdmissionClosed(false);
    await harness.advance(TICK_INTERVAL_MS);
    await harness.advance(TICK_INTERVAL_MS);

    expectRecoveryCount(harness, 1);
  });

  it("re-pends the full recovery when admission closes between steps", async () => {
    const harness = createHarness();
    harness.deps.resetEventLoopHealth.mockImplementationOnce(() => {
      harness.setAdmissionClosed(true);
    });

    await harness.advance(THAW_GAP);
    expectRecoveryCount(harness, 0, 0, 1);

    harness.setAdmissionClosed(false);
    await harness.advance(TICK_INTERVAL_MS);

    expectRecoveryCount(harness, 1, 1, 2);
    expect(harness.deps.logger.info).toHaveBeenCalledWith(
      "host thaw recovery deferred: gateway suspension began mid-recovery",
    );
  });
});
