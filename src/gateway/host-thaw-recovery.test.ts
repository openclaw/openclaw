import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostThawRecovery } from "./host-thaw-recovery.js";
import { TICK_INTERVAL_MS } from "./server-constants.js";

const HOST_THAW_MIN_FROZEN_MS = 45_000;
const THAW_GAP = TICK_INTERVAL_MS + HOST_THAW_MIN_FROZEN_MS;
const BUSY_MESSAGE = "host thaw channel restart deferred: gateway still has active work";
const INCOMPLETE_MESSAGE =
  "host thaw channel restart deferred: one or more channel accounts remain pending";

function createHarness() {
  let nowMs = 0;
  let cpuUsage = { user: 0, system: 0 };
  vi.spyOn(process, "cpuUsage").mockImplementation(() => cpuUsage);
  const state: {
    admissionClosed?: boolean;
    restartReason?: "active-work" | "admission-closed" | "channel-restart-incomplete";
  } = {};
  const deps = {
    nowMs: () => nowMs,
    restartChannelsIfIdle: vi.fn(async () =>
      state.restartReason === undefined
        ? ({ status: "completed" } as const)
        : ({ status: "retry", reason: state.restartReason } as const),
    ),
    refreshHealth: vi.fn(async () => {}),
    refreshPresence: vi.fn(),
    resetEventLoopHealth: vi.fn(),
    isAdmissionClosed: () => state.admissionClosed === true,
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
    state,
    elapse,
    advance: async (gapMs: number, cpuCoreRatio = 0) => {
      elapse(gapMs, cpuCoreRatio);
      await recovery.tick();
    },
  };
}

describe("host thaw recovery", () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    harness = createHarness();
  });
  afterEach(() => vi.restoreAllMocks());

  function expectRecoveryCount(count: number, restarts = count, resets = count) {
    expect(harness.deps.restartChannelsIfIdle).toHaveBeenCalledTimes(restarts);
    expect(harness.deps.refreshHealth).toHaveBeenCalledTimes(count);
    expect(harness.deps.refreshPresence).toHaveBeenCalledTimes(count);
    expect(harness.deps.resetEventLoopHealth).toHaveBeenCalledTimes(resets);
  }
  const restartLogs = (kind: string) =>
    harness.deps.logger.info.mock.calls.filter(([message]) => message.includes(`restart ${kind}`));

  it.each([0.5])("does not recover from a CPU-busy gap with ratio %s", async (cpuCoreRatio) => {
    await harness.advance(TICK_INTERVAL_MS, 0);
    await harness.advance(THAW_GAP, cpuCoreRatio);
    await harness.advance(TICK_INTERVAL_MS);

    expectRecoveryCount(0);
    expect(harness.deps.logger.info).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`gap ${THAW_GAP}ms, CPU ratio ${cpuCoreRatio.toFixed(2)}`),
    );

    await harness.advance(THAW_GAP);
    expectRecoveryCount(1);
  });

  it("excludes slow recovery work from later thaw samples", async () => {
    harness.deps.refreshHealth
      .mockImplementationOnce(async () => harness.elapse(HOST_THAW_MIN_FROZEN_MS))
      .mockImplementationOnce(async () => harness.elapse(HOST_THAW_MIN_FROZEN_MS, 1));

    for (const [gap, count] of [
      [THAW_GAP, 1],
      [TICK_INTERVAL_MS, 1],
      [THAW_GAP, 2],
      [THAW_GAP, 3],
    ] as const) {
      await harness.advance(gap);
      expectRecoveryCount(count);
    }
  });

  it.each(["active-work", "channel-restart-incomplete"] as const)(
    "retries deferred channel restarts (%s)",
    async (reason) => {
      harness.state.restartReason = reason;

      await harness.advance(THAW_GAP);
      expectRecoveryCount(1);

      await harness.advance(TICK_INTERVAL_MS);
      expectRecoveryCount(1, 2);

      harness.state.restartReason = undefined;
      await harness.advance(TICK_INTERVAL_MS);

      expectRecoveryCount(1, 3);
      expect(harness.deps.restartChannelsIfIdle.mock.calls).toEqual([
        ["new-thaw"],
        ["deferred-retry"],
        ["deferred-retry"],
      ]);
      expect(restartLogs("deferred")).toEqual([
        [reason === "active-work" ? BUSY_MESSAGE : INCOMPLETE_MESSAGE],
      ]);
    },
  );

  it.each([false, true])("expires the restart window (admission closed: %s)", async (closed) => {
    harness.state.admissionClosed = closed;
    harness.state.restartReason = closed ? undefined : "active-work";
    await harness.advance(THAW_GAP);
    for (let elapsedMs = TICK_INTERVAL_MS; elapsedMs < 10 * 60_000; elapsedMs += TICK_INTERVAL_MS) {
      await harness.advance(TICK_INTERVAL_MS);
    }
    if (!closed) {
      expect(harness.deps.restartChannelsIfIdle).toHaveBeenCalledTimes(20);
    }
    await harness.advance(TICK_INTERVAL_MS);
    harness.state.admissionClosed = false;
    harness.state.restartReason = undefined;
    await harness.advance(TICK_INTERVAL_MS);
    if (closed) {
      expect(harness.deps.restartChannelsIfIdle).not.toHaveBeenCalled();
      expect(harness.deps.refreshHealth).toHaveBeenCalledOnce();
      expect(harness.deps.refreshPresence).toHaveBeenCalledOnce();
      expect(restartLogs("abandoned")).toHaveLength(1);
    } else {
      expect(harness.deps.restartChannelsIfIdle).toHaveBeenCalledTimes(20);
      expect(restartLogs("deferred")).toEqual([[BUSY_MESSAGE]]);
      expect(restartLogs("abandoned")).toEqual([[expect.stringContaining("gateway stayed busy")]]);
      await harness.advance(THAW_GAP);
      expect(harness.deps.restartChannelsIfIdle).toHaveBeenCalledTimes(21);
    }
  });

  it.each(["before", "during"])(
    "resumes recovery after admission closes %s recovery",
    async (when) => {
      const midRecovery = when === "during";
      if (midRecovery) {
        harness.deps.resetEventLoopHealth.mockImplementationOnce(() => {
          harness.state.admissionClosed = true;
        });
      } else {
        harness.state.admissionClosed = true;
      }
      await harness.advance(THAW_GAP);
      expectRecoveryCount(0, 0, midRecovery ? 1 : 0);
      harness.state.admissionClosed = false;
      await harness.advance(TICK_INTERVAL_MS);
      if (midRecovery) {
        expect(harness.deps.logger.info).toHaveBeenCalledWith(
          "host thaw recovery deferred: gateway suspension began mid-recovery",
        );
      } else {
        await harness.advance(TICK_INTERVAL_MS);
      }
      expectRecoveryCount(1, 1, midRecovery ? 2 : 1);
    },
  );
});
