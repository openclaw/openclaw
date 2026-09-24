import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewayRestart,
  setPreRestartDeferralCheck,
} from "./restart.js";

describe("scheduled restart requester authority", () => {
  const signal = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    setPreRestartDeferralCheck(() => 0);
    signal.mockClear();
    // A test-only listener keeps emission in process; no OS signal or supervisor is used.
    process.on("SIGUSR2", signal);
  });

  afterEach(() => {
    process.removeListener("SIGUSR2", signal);
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    setPreRestartDeferralCheck(() => 0);
    vi.useRealTimers();
  });

  it.each(["timer", "idle", "preparation", "failed-preparation"] as const)(
    "cancels a revoked request at the %s boundary and admits a later system restart",
    async (stage) => {
      let current = true;
      let pending = stage === "idle" ? 1 : 0;
      const entered = createDeferred();
      const release = createDeferred();
      const beforeEmit = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        if (stage === "failed-preparation") {
          throw new Error("sentinel preparation failed");
        }
      });
      const afterEmitRejected = vi.fn(async () => {});
      setPreRestartDeferralCheck(() => pending);
      scheduleGatewayRestart({
        delayMs: stage === "timer" ? 1_000 : 0,
        sessionKey: "requester-a",
        emitHooks: {
          assertCurrent: () => {
            if (!current) {
              throw new Error("linked administrator was demoted");
            }
          },
          beforeEmit,
          afterEmitRejected,
        },
      });
      if (stage === "preparation" || stage === "failed-preparation") {
        await vi.advanceTimersByTimeAsync(0);
        await entered.promise;
      } else if (stage === "idle") {
        await vi.advanceTimersByTimeAsync(0);
      }
      current = false;
      pending = 0;
      release.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(signal).not.toHaveBeenCalled();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(beforeEmit).toHaveBeenCalledTimes(stage.includes("preparation") ? 1 : 0);
      expect(afterEmitRejected).toHaveBeenCalledTimes(stage === "preparation" ? 1 : 0);
      scheduleGatewayRestart({ delayMs: 0, skipCooldown: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(signal).toHaveBeenCalledOnce();
    },
  );

  it.each(["first", "second", "both", "system"] as const)(
    "keeps coalesced requester authority independent when %s is revoked",
    async (revoked) => {
      let firstCurrent = true;
      let secondCurrent = true;
      const firstPreparation = vi.fn(async () => {});
      const secondPreparation = vi.fn(async () => {});
      scheduleGatewayRestart({
        delayMs: 1_000,
        sessionKey: "requester-a",
        emitHooks: {
          assertCurrent: () => {
            if (!firstCurrent) {
              throw new Error("first requester revoked");
            }
          },
          beforeEmit: firstPreparation,
        },
      });
      const second = scheduleGatewayRestart({
        delayMs: 1_000,
        sessionKey: "requester-b",
        ...(revoked === "system"
          ? {}
          : {
              emitHooks: {
                assertCurrent: () => {
                  if (!secondCurrent) {
                    throw new Error("second requester revoked");
                  }
                },
                beforeEmit: secondPreparation,
              },
            }),
      });
      expect(second.coalesced).toBe(true);
      expect(second.emitHooksQueued).toBe(false);
      firstCurrent = revoked === "second";
      secondCurrent = revoked === "first";
      await vi.advanceTimersByTimeAsync(1_000);

      expect(signal).toHaveBeenCalledTimes(revoked === "both" ? 0 : 1);
      expect(firstPreparation).toHaveBeenCalledTimes(firstCurrent ? 1 : 0);
      expect(secondPreparation).not.toHaveBeenCalled();
    },
  );

  it("accepts a live coalesced request while the original acknowledgement is preparing", async () => {
    let current = true;
    const entered = createDeferred();
    const release = createDeferred();
    const afterEmitRejected = vi.fn(async () => {});
    scheduleGatewayRestart({
      delayMs: 0,
      sessionKey: "requester-a",
      emitHooks: {
        assertCurrent: () => {
          if (!current) {
            throw new Error("original requester revoked");
          }
        },
        beforeEmit: async () => {
          entered.resolve();
          await release.promise;
        },
        afterEmitRejected,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    scheduleGatewayRestart({
      delayMs: 0,
      sessionKey: "requester-b",
      emitHooks: { assertCurrent: () => {} },
    });
    current = false;
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(afterEmitRejected).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledOnce();
  });
});
