/** Registers external handoff shutdown contracts in the shared run-loop fixture. */
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureEnv } from "../../test-utils/env.js";
import {
  expectRestartCloseCall,
  waitForLoopCondition,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerExternalHandoffShutdownTests(
  {
    consumeGatewaySuspendHandoff,
    acquireGatewayLock,
    peekGatewayRestartReason,
    createSignaledLoopHarness,
    waitForGatewayActiveWork,
    restartGatewayProcessWithFreshPid,
    respawnGatewayProcessForUpdate,
    writeGatewayRestartHandoff,
    prepareGatewayRestartHandoffRuntime,
    cancelShutdownHardExitWatchdog,
    gatewayLog,
    isGatewayWorkAdmissionClosed,
  }: UpdateRespawnFixtures,
  restartDeferralTimeoutMs: number,
): void {
  it.each([
    { fails: true, trigger: "signal" },
    { fails: false, trigger: "commit" },
  ])(
    "joins external restart cleanup without a successor ($trigger, close failure: $fails)",
    async ({ fails, trigger }) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start, runtime, exited } = await createSignaledLoopHarness(undefined, true);
        const host = start.mock.calls[0]?.[0]?.hostLifecycle;
        const joined = createDeferredCore();
        close.mockImplementationOnce(async () => {
          await joined.promise;
          if (fails) {
            throw new Error("external cleanup failed");
          }
        });
        consumeGatewaySuspendHandoff.mockImplementationOnce((owner) => {
          expect(owner).toBe(host?.externalRestart);
          expect(owner?.isCurrent()).toBe(true);
          expect(isGatewayWorkAdmissionClosed()).toBe(false);
          return { ok: true, value: true };
        });
        try {
          const sigterm = captureSignal("SIGTERM");
          if (trigger === "commit") {
            if (!host?.externalRestart?.commitStop) {
              throw new Error("Missing committed stop capability");
            }
            host.externalRestart.commitStop();
            expect(isGatewayWorkAdmissionClosed()).toBe(true);
          } else {
            sigterm();
          }
          await waitForLoopCondition(
            () => close.mock.calls.length === 1,
            "external cleanup did not begin",
          );
          sigterm();
          expect(host?.externalRestart?.isCurrent()).toBe(false);
          expectRestartCloseCall(close, restartDeferralTimeoutMs);
          expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
        } finally {
          joined.resolve();
        }
        await expect(exited).resolves.toBe(fails ? 1 : 0);
        expect(consumeGatewaySuspendHandoff).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        expect(writeGatewayRestartHandoff).not.toHaveBeenCalled();
        expect(cancelShutdownHardExitWatchdog).toHaveBeenCalled();
      });
    },
  );

  it.each([
    { marker: "OPENCLAW_SUPERVISOR_MODE", value: "external", exitCode: undefined },
    { marker: "OPENCLAW_WINDOWS_TASK_NAME", value: "OpenClaw Gateway", exitCode: 75 },
  ])(
    "releases the lock before supervised restart exit $exitCode",
    async ({ marker, value, exitCode }) => {
      peekGatewayRestartReason.mockReturnValue(undefined);
      const env = captureEnv([marker, "OPENCLAW_GATEWAY_RESTART_TRACE"]);
      process.env[marker] = value;
      process.env.OPENCLAW_GATEWAY_RESTART_TRACE = "1";
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const exitCallOrder: string[] = [];
          const lockRelease = vi.fn(async () => {
            exitCallOrder.push("lockRelease");
          });
          acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
          restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised", exitCode });
          const handoffEntered = createDeferredCore();
          const releaseHandoff = createDeferredCore();
          const writeHandoff = writeGatewayRestartHandoff.getMockImplementation()!;
          writeGatewayRestartHandoff.mockImplementationOnce(async (...args) => {
            handoffEntered.resolve();
            await releaseHandoff.promise;
            return writeHandoff(...args);
          });
          const { runtime, exited } = await createSignaledLoopHarness(exitCallOrder);
          captureSignal("SIGUSR2")();
          await handoffEntered.promise;
          try {
            expect(runtime.exit).not.toHaveBeenCalled();
          } finally {
            releaseHandoff.resolve();
          }
          await expect(exited).resolves.toBe(exitCode ?? 0);
          expect(lockRelease).toHaveBeenCalledOnce();
          expect(runtime.exit).toHaveBeenCalledWith(exitCode ?? 0);
          expect(exitCallOrder).toEqual(["lockRelease", "exit"]);
          const [respawnOpts] = restartGatewayProcessWithFreshPid.mock.calls[0] ?? [];
          expect(respawnOpts?.env?.OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS).toMatch(/^\d/u);
          expect(respawnOpts?.env?.OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS).toMatch(/^\d/u);
          expect(writeGatewayRestartHandoff).toHaveBeenCalledOnce();
        });
      } finally {
        env.restore();
      }
    },
  );

  it("falls back in-process when an external restart handoff cannot be persisted", async () => {
    peekGatewayRestartReason.mockReturnValue(undefined);
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
    });
    writeGatewayRestartHandoff.mockResolvedValueOnce(null);

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const sigint = captureSignal("SIGINT");

        restartSignal();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "external handoff failure did not restart in-process",
        );

        expect(runtime.exit).not.toHaveBeenCalled();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(gatewayLog.warn).toHaveBeenCalledWith(
          "external supervisor restart handoff could not be persisted; falling back to in-process restart",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
    }
  });

  it("prepares restart code before close and publishes the handoff only after close", async () => {
    const env = captureEnv(["OPENCLAW_SUPERVISOR_MODE"]);
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    const closed = createDeferredCore();
    const closeEntered = createDeferredCore();
    const cleanup = createDeferredCore();
    const preparation = { release: vi.fn(() => cleanup.promise) };
    prepareGatewayRestartHandoffRuntime.mockReturnValueOnce(preparation);
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, runtime, exited } = await createSignaledLoopHarness();
        close.mockImplementationOnce(async () => {
          closeEntered.resolve();
          await closed.promise;
        });
        captureSignal("SIGUSR2")();
        await closeEntered.promise;
        try {
          expect(prepareGatewayRestartHandoffRuntime).toHaveBeenCalledOnce();
          expect(writeGatewayRestartHandoff).not.toHaveBeenCalled();
        } finally {
          closed.resolve();
        }
        await waitForLoopCondition(
          () => preparation.release.mock.calls.length > 0,
          "restart preparation cleanup did not begin",
        );
        try {
          expect(writeGatewayRestartHandoff).toHaveBeenCalledWith(
            expect.objectContaining({ runtimePreparation: preparation }),
            expect.any(Function),
          );
          expect(runtime.exit).not.toHaveBeenCalled();
        } finally {
          cleanup.resolve();
        }
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      closed.resolve();
      cleanup.resolve();
      env.restore();
    }
  });

  it("joins unused runtime preparation before resuming an in-process restart", async () => {
    const env = captureEnv(["OPENCLAW_SUPERVISOR_MODE"]);
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    const cleanup = createDeferredCore();
    const preparation = { release: vi.fn(() => cleanup.promise) };
    prepareGatewayRestartHandoffRuntime.mockReturnValueOnce(preparation);
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "failed", detail: "fixture" });
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, exited } = await createSignaledLoopHarness();
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () => preparation.release.mock.calls.length > 0,
          "unused preparation cleanup did not begin",
        );
        try {
          expect(start).toHaveBeenCalledOnce();
          expect(writeGatewayRestartHandoff).not.toHaveBeenCalled();
        } finally {
          cleanup.resolve();
        }
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "restart did not resume after code preparation closed",
        );
        captureSignal("SIGINT")();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      cleanup.resolve();
      env.restore();
    }
  });

  it("keeps the ordinary drain when a handoff refuses late terminal persistence", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, exited } = await createSignaledLoopHarness(undefined, true);
      consumeGatewaySuspendHandoff.mockReturnValueOnce({
        ok: false,
        error: "gateway terminal persistence is still pending",
      });
      captureSignal("SIGTERM")();
      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, expect.any(Object));
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
        exitAfterClose: true,
      });
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "external restart handoff refused: gateway terminal persistence is still pending",
      );
    });
  });
}
