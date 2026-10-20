import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "./gateway-suspend-coordinator.js";
import { inspectors } from "./gateway-suspend-coordinator.test-support.js";
import {
  isGatewayRestartExternallyAllowed,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewayRestart,
  setGatewayRestartPolicy,
  setPreRestartDeferralCheck,
} from "./restart.js";

const resumeScheduling = vi.fn();

function prepareSuspension(requestId = "request") {
  return prepareGatewaySuspend({
    requestId,
    createSuspensionId: () => "suspension",
    pauseScheduling: vi.fn(),
    resumeScheduling,
    inspect: inspectors({ getRootRequests: () => getActiveGatewayRootWorkCount() }),
  });
}

let emitSpy: MockInstance<typeof process.emit>;
function expectSignals(count: number) {
  expect(emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR2")).toHaveLength(count);
}

async function requestTargetedRestart() {
  const admission = tryBeginGatewayPreparedRestartRootWorkAdmission();
  expect(admission?.ownsRoot).toBe(true);
  const result = await admission?.run(async () =>
    requestGatewayRestartWithSignalAdmission("gateway.restart", { waitMs: 5_000 }),
  );
  admission?.release();
  return result;
}

function resetGatewayLifecycleState(): void {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
  resetGatewayRestartStateForInProcessRestart();
  setGatewayRestartPolicy({ allowExternal: false });
  setPreRestartDeferralCheck(() => 0);
}

function schedulePreparingRestart(afterEmitRejected?: () => Promise<void>, reason?: string) {
  const preparation = createDeferred();
  const beforeEmit = vi.fn(async () => preparation.promise);
  scheduleGatewayRestart({ delayMs: 0, reason, emitHooks: { beforeEmit, afterEmitRejected } });
  return { release: preparation.resolve, beforeEmit };
}

describe("scheduled restart during gateway suspension", () => {
  const restartSignalHandler = () => {};

  beforeEach(() => {
    resetGatewayLifecycleState();
    resumeScheduling.mockReset();
    vi.useFakeTimers();
    process.on("SIGUSR2", restartSignalHandler);
    emitSpy = vi.spyOn(process, "emit");
  });

  afterEach(() => {
    process.removeListener("SIGUSR2", restartSignalHandler);
    resetGatewayLifecycleState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defers a previously scheduled restart until a ready suspension resumes", async () => {
    scheduleGatewayRestart({ delayMs: 1_000, reason: "config.patch" });

    expect(prepareSuspension().status).toBe("ready");

    await vi.advanceTimersByTimeAsync(1_000);
    expectSignals(0);

    expect(resumeGatewaySuspend("suspension")).toMatchObject({ ok: true, resumed: true });
    await vi.advanceTimersByTimeAsync(0);
    expectSignals(1);
  });

  it.each(["emitted", "failed"])(
    "preserves suspension ownership when targeted restart is %s",
    async (status) => {
      expect(prepareSuspension()).toMatchObject({ status: "ready" });
      const restartHandler = () => markGatewayRestartDraining();
      if (status === "emitted") {
        process.on("SIGUSR2", restartHandler);
      } else {
        emitSpy.mockImplementationOnce(() => {
          throw new Error("synthetic signal failure");
        });
      }
      try {
        expect(await requestTargetedRestart()).toEqual({ status });
        expect(resumeScheduling).not.toHaveBeenCalled();
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        if (status === "emitted") {
          expect(getGatewaySuspendStatus("suspension", true)).toMatchObject({
            status: "draining",
            ownerId: "request",
            phase: "interrupting",
          });
        } else {
          expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
          expect(getGatewaySuspendStatus("suspension")).toEqual({
            status: "ready",
            expiresAtMs: expect.any(Number),
            writeCustody: [],
          });
          expect(resumeGatewaySuspend("suspension")).toEqual({
            ok: true,
            status: "running",
            resumed: true,
          });
          expect(resumeScheduling).toHaveBeenCalledOnce();
          expect(isGatewayWorkAdmissionClosed()).toBe(false);
        }
      } finally {
        process.removeListener("SIGUSR2", restartHandler);
      }
    },
  );

  it("reports active work while a due restart is preparing to emit", async () => {
    const preparation = schedulePreparingRestart(undefined, "config.patch");
    await vi.advanceTimersByTimeAsync(0);

    expect(prepareSuspension()).toMatchObject({
      status: "busy",
      reason: "gateway-draining",
      activeCount: 1,
    });
    expectSignals(0);

    preparation.release();
    await vi.advanceTimersByTimeAsync(0);
    expectSignals(1);

    expect(prepareSuspension("next-request")).toMatchObject({
      status: "busy",
      reason: "gateway-draining",
    });
  });

  it("resets transient restart state and cooldown without dropping live bindings", async () => {
    const preRestartCheck = vi.fn(() => 0);
    setPreRestartDeferralCheck(preRestartCheck);
    setGatewayRestartPolicy({ allowExternal: true });

    scheduleGatewayRestart({ delayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expectSignals(1);
    expect(preRestartCheck).toHaveBeenCalledTimes(2);
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    resetGatewayRestartStateForInProcessRestart();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    expect(isGatewayRestartExternallyAllowed()).toBe(true);

    scheduleGatewayRestart({ delayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expectSignals(2);
    expect(preRestartCheck).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])("cancels pending restart on reset (suspended: %s)", async (suspended) => {
    if (suspended) {
      expect(prepareSuspension()).toMatchObject({ status: "ready" });
    }
    scheduleGatewayRestart({ delayMs: suspended ? 0 : 1_000 });
    if (suspended) {
      await vi.advanceTimersByTimeAsync(0);
      expectSignals(0);
      resetGatewaySuspendCoordinatorForLifecycleRestart();
      resetGatewayWorkAdmission();
    }
    resetGatewayRestartStateForInProcessRestart();
    await vi.advanceTimersByTimeAsync(suspended ? 0 : 1_000);
    expectSignals(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("rejects prepared hooks that finish after a transient reset", async () => {
    const afterEmitRejected = vi.fn(async () => {});
    const preparation = schedulePreparingRestart(afterEmitRejected);
    await vi.advanceTimersByTimeAsync(0);
    expect(preparation.beforeEmit).toHaveBeenCalledOnce();

    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    preparation.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(afterEmitRejected).toHaveBeenCalledOnce();
    expectSignals(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("resumes and clears a prepared suspension during lifecycle reset", () => {
    expect(prepareSuspension()).toMatchObject({ status: "ready" });

    markGatewayRestartDraining();
    expect(resumeScheduling).not.toHaveBeenCalled();
    resetGatewayLifecycleState();

    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(getGatewaySuspendStatus("suspension")).toEqual({ status: "running" });
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });
});
