// Pins scheduled restart ordering against the reversible host-suspension fence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "./gateway-suspend-coordinator.js";
import {
  isGatewayRestartExternallyAllowed,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewayRestart,
  setGatewayRestartPolicy,
  setPreRestartDeferralCheck,
} from "./restart.js";

function inspectors(): GatewayActiveWorkInspectors {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => getActiveGatewayRootWorkCount(),
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  };
}

function countRestartSignalEmits(calls: readonly unknown[][]): number {
  return calls.filter((args) => args[0] === "SIGUSR2").length;
}

function resetGatewayLifecycleState(): void {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayRestartStateForInProcessRestart();
}

describe("scheduled restart during gateway suspension", () => {
  const restartSignalHandler = () => {};

  beforeEach(() => {
    resetGatewayLifecycleState();
    setGatewayRestartPolicy({ allowExternal: false });
    setPreRestartDeferralCheck(() => 0);
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    process.on("SIGUSR2", restartSignalHandler);
  });

  afterEach(() => {
    process.removeListener("SIGUSR2", restartSignalHandler);
    resetGatewayLifecycleState();
    setGatewayRestartPolicy({ allowExternal: false });
    setPreRestartDeferralCheck(() => 0);
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defers a previously scheduled restart until a ready suspension resumes", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    scheduleGatewayRestart({
      delayMs: 1_000,
      reason: "config.patch",
      skipCooldown: true,
    });

    const prepared = prepareGatewaySuspend({
      requestId: "request-restart-delay",
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: inspectors(),
      createSuspensionId: () => "suspension-restart-delay",
    });
    expect(prepared.status).toBe("ready");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(0);

    expect(resumeGatewaySuspend("suspension-restart-delay")).toMatchObject({
      ok: true,
      resumed: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(1);
  });

  it("lets delivered targeted restart drain retain prepared suspension ownership", async () => {
    const restartHandler = () => markGatewayRestartDraining();
    const resumeScheduling = vi.fn();
    process.on("SIGUSR2", restartHandler);
    try {
      const prepared = prepareGatewaySuspend({
        requestId: "request-targeted-restart",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
        createSuspensionId: () => "suspension-targeted-restart",
      });
      expect(prepared).toMatchObject({ status: "ready" });
      const admission = tryBeginGatewayPreparedRestartRootWorkAdmission();
      expect(admission?.ownsRoot).toBe(true);

      const result = await admission?.run(async () =>
        requestGatewayRestartWithSignalAdmission("gateway.restart", { waitMs: 5_000 }),
      );
      admission?.release();

      expect(result).toEqual({ status: "emitted" });
      expect(getGatewaySuspendStatus("suspension-targeted-restart", true)).toMatchObject({
        status: "draining",
        ownerId: "request-targeted-restart",
        phase: "interrupting",
      });
      expect(resumeScheduling).not.toHaveBeenCalled();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
    } finally {
      process.removeListener("SIGUSR2", restartHandler);
    }
  });

  it("preserves prepared suspension when targeted restart delivery fails", async () => {
    const resumeScheduling = vi.fn();
    const prepared = prepareGatewaySuspend({
      requestId: "request-failed-targeted-restart",
      pauseScheduling: vi.fn(),
      resumeScheduling,
      inspect: inspectors(),
      createSuspensionId: () => "suspension-failed-targeted-restart",
    });
    expect(prepared).toMatchObject({ status: "ready" });
    const admission = tryBeginGatewayPreparedRestartRootWorkAdmission();
    expect(admission?.ownsRoot).toBe(true);
    const emitSpy = vi.spyOn(process, "emit").mockImplementationOnce(() => {
      throw new Error("synthetic signal failure");
    });

    const result = await admission?.run(async () =>
      requestGatewayRestartWithSignalAdmission("gateway.restart", { waitMs: 5_000 }),
    );
    admission?.release();

    expect(result).toEqual({ status: "failed" });
    expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
    expect(getGatewaySuspendStatus("suspension-failed-targeted-restart")).toEqual({
      status: "ready",
      expiresAtMs: expect.any(Number),
      writeCustody: [],
    });
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(resumeGatewaySuspend("suspension-failed-targeted-restart")).toEqual({
      ok: true,
      status: "running",
      resumed: true,
    });
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("reports active work while a due restart is preparing to emit", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    const { promise: preparation, resolve: releasePreparation } = createDeferred();
    scheduleGatewayRestart({
      delayMs: 0,
      reason: "config.patch",
      skipCooldown: true,
      emitHooks: {
        beforeEmit: async () => preparation,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    const prepared = prepareGatewaySuspend({
      requestId: "request-restart-preparing",
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: inspectors(),
    });
    expect(prepared).toMatchObject({
      status: "busy",
      reason: "gateway-draining",
      activeCount: 1,
    });
    expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(0);

    releasePreparation();
    await vi.advanceTimersByTimeAsync(0);
    expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(1);

    expect(
      prepareGatewaySuspend({
        requestId: "request-after-restart-signal",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect: inspectors(),
      }),
    ).toMatchObject({
      status: "busy",
      reason: "gateway-draining",
    });
  });

  it("resets transient restart state and cooldown without dropping live bindings", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    const preRestartCheck = vi.fn(() => 0);
    setPreRestartDeferralCheck(preRestartCheck);
    setGatewayRestartPolicy({ allowExternal: true });

    scheduleGatewayRestart({ delayMs: 0, skipCooldown: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(1);
    expect(preRestartCheck).toHaveBeenCalledTimes(2);
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    resetGatewayRestartStateForInProcessRestart();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    expect(isGatewayRestartExternallyAllowed()).toBe(true);

    scheduleGatewayRestart({ delayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(2);
    expect(preRestartCheck).toHaveBeenCalledTimes(4);
  });

  it("cancels delayed restart work during a transient reset", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    scheduleGatewayRestart({ delayMs: 1_000, skipCooldown: true });

    resetGatewayRestartStateForInProcessRestart();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("cancels a due restart waiting behind a prepared suspension", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    expect(
      prepareGatewaySuspend({
        requestId: "request-reset-waiting-restart",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect: inspectors(),
      }),
    ).toMatchObject({ status: "ready" });
    scheduleGatewayRestart({ delayMs: 0, skipCooldown: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(0);

    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
    resetGatewayRestartStateForInProcessRestart();
    await vi.advanceTimersByTimeAsync(0);

    expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("rejects prepared hooks that finish after a transient reset", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    const preparationStarted = vi.fn();
    const afterEmitRejected = vi.fn();
    const { promise: preparation, resolve: releasePreparation } = createDeferred();
    scheduleGatewayRestart({
      delayMs: 0,
      skipCooldown: true,
      emitHooks: {
        beforeEmit: async () => {
          preparationStarted();
          await preparation;
        },
        afterEmitRejected,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(preparationStarted).toHaveBeenCalledOnce();

    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    releasePreparation();
    await vi.advanceTimersByTimeAsync(0);

    expect(afterEmitRejected).toHaveBeenCalledOnce();
    expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("resumes and clears a prepared suspension during lifecycle reset", () => {
    const resumeScheduling = vi.fn();
    expect(
      prepareGatewaySuspend({
        requestId: "request-lifecycle-reset",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
        createSuspensionId: () => "suspension-lifecycle-reset",
      }),
    ).toMatchObject({ status: "ready" });

    markGatewayRestartDraining();
    expect(resumeScheduling).not.toHaveBeenCalled();
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
    resetGatewayRestartStateForInProcessRestart();

    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(getGatewaySuspendStatus("suspension-lifecycle-reset")).toEqual({ status: "running" });
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });
});
