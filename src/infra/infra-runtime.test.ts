import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
// Tests infra runtime loading and platform-dependent helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot } from "../config/config.js";
import {
  beginGatewayRestartSignalAdmission,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import * as errorFormatting from "./errors.js";
type RestartModule = typeof import("./restart.js");
const managedSuccessorOwner = {
  kind: "managed-update-handoff",
  handoffId: "managed-handoff",
  installRoot: "/canonical/install",
} as const;

let consumeGatewayRestartAuthorization: RestartModule["consumeGatewayRestartAuthorization"];
let consumeGatewayRestartIntent: RestartModule["consumeGatewayRestartIntent"];
let deferGatewayRestartUntilIdle: RestartModule["deferGatewayRestartUntilIdle"];
let isGatewayRestartExternallyAllowed: RestartModule["isGatewayRestartExternallyAllowed"];
let markGatewayRestartHandled: RestartModule["markGatewayRestartHandled"];
let peekGatewayRestartReason: RestartModule["peekGatewayRestartReason"];
let requestGatewayRestartWithSignalAdmission: RestartModule["requestGatewayRestartWithSignalAdmission"];
let rollbackGatewayRestartSignalAdmission: RestartModule["rollbackGatewayRestartSignalAdmission"];
let scheduleGatewayRestart: RestartModule["scheduleGatewayRestart"];
let setGatewayRestartPolicy: RestartModule["setGatewayRestartPolicy"];
let setPreRestartDeferralCheck: RestartModule["setPreRestartDeferralCheck"];
let freshRestartModuleId = 0;

const relaunchGatewayScheduledTaskMock = vi.hoisted(() => vi.fn());
const cleanStaleGatewayProcessesSyncMock = vi.hoisted(() => vi.fn());
const findGatewayPidsOnPortSyncMock = vi.hoisted(() => vi.fn());
const restartLogWarnMock = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "restart" ? { ...logger, warn: restartLogWarnMock } : logger;
    },
  };
});

vi.mock("./restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: (...args: unknown[]) =>
    cleanStaleGatewayProcessesSyncMock(...args),
  findGatewayPidsOnPortSync: (...args: unknown[]) => findGatewayPidsOnPortSyncMock(...args),
}));

vi.mock("./windows-task-restart.js", () => ({
  relaunchGatewayScheduledTask: (...args: unknown[]) => relaunchGatewayScheduledTaskMock(...args),
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

function withoutRestartSignalListeners(fn: () => void): void {
  const listeners = process.listeners("SIGUSR2");
  process.removeAllListeners("SIGUSR2");
  try {
    fn();
  } finally {
    process.removeAllListeners("SIGUSR2");
    for (const listener of listeners) {
      process.on("SIGUSR2", listener);
    }
  }
}

function withRestartSupervisorEnabled(fn: () => void): void {
  const originalVitest = process.env.VITEST;
  const originalNodeEnv = process.env.NODE_ENV;
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
  try {
    fn();
  } finally {
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
}

function countRestartSignalEmits(calls: readonly unknown[][]): number {
  let count = 0;
  for (const args of calls) {
    if (args[0] === "SIGUSR2") {
      count += 1;
    }
  }
  return count;
}

describe("infra runtime", () => {
  function setupRestartSignalSuite() {
    beforeEach(async () => {
      restartLogWarnMock.mockReset();
      const restart = await importFreshModule<RestartModule>(
        import.meta.url,
        `./restart.js?infra-runtime=${freshRestartModuleId++}`,
      );
      ({
        consumeGatewayRestartAuthorization,
        consumeGatewayRestartIntent,
        deferGatewayRestartUntilIdle,
        isGatewayRestartExternallyAllowed,
        markGatewayRestartHandled,
        peekGatewayRestartReason,
        requestGatewayRestartWithSignalAdmission,
        rollbackGatewayRestartSignalAdmission,
        scheduleGatewayRestart,
        setGatewayRestartPolicy,
        setPreRestartDeferralCheck,
      } = restart);
      relaunchGatewayScheduledTaskMock.mockReset();
      relaunchGatewayScheduledTaskMock.mockReturnValue({ ok: true, method: "schtasks" });
      cleanStaleGatewayProcessesSyncMock.mockReset();
      cleanStaleGatewayProcessesSyncMock.mockReturnValue([]);
      findGatewayPidsOnPortSyncMock.mockReset();
      findGatewayPidsOnPortSyncMock.mockReturnValue([]);
      setGatewayRestartPolicy({ allowExternal: false });
      vi.useFakeTimers();
      vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    afterEach(() => {
      vi.clearAllTimers();
      markGatewayRestartHandled();
      resetGatewayWorkAdmission();
      clearRuntimeConfigSnapshot();
      vi.useRealTimers();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
      vi.restoreAllMocks();
    });
  }

  describe("restart authorization", () => {
    setupRestartSignalSuite();

    it("reopens admission when refused-handler rollback finds no live emission lease", () => {
      // Fence closed outside restart.ts ownership (lost/overwritten lease).
      const orphanLease = beginGatewayRestartSignalAdmission();
      expect(orphanLease).not.toBeNull();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);

      // Run-loop refused path: mark handled / explicit rollback with no stored lease.
      expect(rollbackGatewayRestartSignalAdmission()).toBe(true);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(orphanLease?.rollback()).toBe(false);

      const root = tryBeginGatewayRootWorkAdmission();
      expect(root).not.toBeNull();
      root?.release();
    });

    it("does not leave admission closed when a deferred emission is cancelled mid-prepare", async () => {
      const { promise: prepareGate, resolve: releasePrepare } = createDeferred();
      const handle = deferGatewayRestartUntilIdle({
        getPendingCount: () => 0,
        reason: "config.reload.cancelled",
        emitHooks: {
          beforeEmit: async () => {
            await prepareGate;
          },
        },
      });
      await Promise.resolve();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);

      handle.cancel();
      releasePrepare?.();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      const root = tryBeginGatewayRootWorkAdmission();
      expect(root).not.toBeNull();
      root?.release();
    });

    it("keeps admission open when a deferred restart emission races config supersession", async () => {
      let pending = 1;
      const { promise: prepareGate, resolve: releasePrepare } = createDeferred();
      const handle = deferGatewayRestartUntilIdle({
        getPendingCount: () => pending,
        reason: "config.reload.superseded",
        emitHooks: {
          beforeEmit: async () => {
            await prepareGate;
          },
          emitRestart: () => ({ status: "coalesced" as const }),
        },
      });
      expect(isGatewayWorkAdmissionClosed()).toBe(false);

      pending = 0;
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);

      // Superseding reload cancels the in-flight emission before signal delivery.
      handle.cancel();
      releasePrepare?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    });

    it("keeps the signal fence closed when cancel races a concurrent emitted SIGUSR2", async () => {
      const { promise: prepareGate, resolve: releasePrepare } = createDeferred();
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        const handle = deferGatewayRestartUntilIdle({
          getPendingCount: () => 0,
          reason: "config.reload.shared-fence",
          emitHooks: {
            beforeEmit: async () => {
              await prepareGate;
            },
          },
        });
        await Promise.resolve();
        expect(isGatewayWorkAdmissionClosed()).toBe(true);

        // Concurrent path reuses the deferred prepare lease and queues SIGUSR2.
        expect(requestGatewayRestartWithSignalAdmission("concurrent.emit")).toEqual({
          status: "emitted",
        });
        expect(isGatewayWorkAdmissionClosed()).toBe(true);

        handle.cancel();
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();

        releasePrepare?.();
        await Promise.resolve();
        await Promise.resolve();

        // In-flight signal still owns the fence until the handled path reopens it.
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();

        markGatewayRestartHandled();
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("backs off before an emoji that crosses the restart reason limit", () => {
      const restart = scheduleGatewayRestart({
        delayMs: 0,
        reason: "x".repeat(199) + "🧠tail",
      });

      expect(restart.reason).toBe("x".repeat(199));
    });

    it("tracks external restart policy", () => {
      expect(isGatewayRestartExternallyAllowed()).toBe(false);
      setGatewayRestartPolicy({ allowExternal: true });
      expect(isGatewayRestartExternallyAllowed()).toBe(true);
    });

    it.each([process.platform, "win32"] as const)(
      "suppresses duplicate signals until handled on %s",
      (platform) => {
        setPlatform(platform);
        const emitSpy = vi.spyOn(process, "emit");
        const handler = () => {};
        process.on("SIGUSR2", handler);
        try {
          expect(requestGatewayRestartWithSignalAdmission()).toEqual({ status: "emitted" });
          expect(requestGatewayRestartWithSignalAdmission()).toEqual({ status: "coalesced" });
          expect(consumeGatewayRestartAuthorization()).toBe(true);

          markGatewayRestartHandled();

          expect(requestGatewayRestartWithSignalAdmission()).toEqual({ status: "emitted" });
          expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(2);
          expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
        } finally {
          process.removeListener("SIGUSR2", handler);
        }
      },
    );

    it.each([false, true])(
      "settles Windows supervisor fallback state (initial failure: %s)",
      (failsFirst) => {
        setPlatform("win32");
        withoutRestartSignalListeners(() => {
          withRestartSupervisorEnabled(() => {
            if (failsFirst) {
              relaunchGatewayScheduledTaskMock.mockReturnValueOnce({
                ok: false,
                method: "schtasks",
                detail: "denied",
              });
              expect(requestGatewayRestartWithSignalAdmission("windows-fallback")).toEqual({
                status: "failed",
              });
              expect(consumeGatewayRestartAuthorization()).toBe(false);
            }
            expect(requestGatewayRestartWithSignalAdmission("windows-retry")).toEqual({
              status: "emitted",
            });
            expect(relaunchGatewayScheduledTaskMock).toHaveBeenCalledTimes(failsFirst ? 2 : 1);
            expect(consumeGatewayRestartAuthorization()).toBe(false);
            const next = scheduleGatewayRestart({ delayMs: 0, reason: "next" });
            expect(next.coalesced).toBe(false);
            expect(next.mode).toBe("supervisor");
          });
        });
      },
    );

    it("coalesces duplicate scheduled restarts into a single pending timer", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        const first = scheduleGatewayRestart({ delayMs: 1_000, reason: "first" });
        const second = scheduleGatewayRestart({ delayMs: 1_000, reason: "second" });

        expect(first.coalesced).toBe(false);
        expect(second.coalesced).toBe(true);

        await vi.advanceTimersByTimeAsync(999);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR2");

        await vi.advanceTimersByTimeAsync(1);
        const restartSignalEmits = emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR2");
        expect(restartSignalEmits.length).toBe(1);
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it.each(["update.run", "update.auto"] as const)(
      "preserves %s restart reason when a scheduled restart coalesces",
      async (reason) => {
        const handler = () => {};
        process.on("SIGUSR2", handler);
        try {
          const first = scheduleGatewayRestart({ delayMs: 1_000, reason: "config.patch" });
          const second = scheduleGatewayRestart({ delayMs: 1_000, reason });

          expect(first.coalesced).toBe(false);
          expect(second.coalesced).toBe(true);

          await vi.advanceTimersByTimeAsync(1_000);

          expect(peekGatewayRestartReason()).toBe(reason);
        } finally {
          process.removeListener("SIGUSR2", handler);
        }
      },
    );

    it("promotes update.auto while restart preparation is in flight", async () => {
      const { promise: preparationBlocked, resolve: releasePreparation } = createDeferred();
      const beforeEmit = vi.fn(async () => {
        await preparationBlocked;
      });
      const staleEmitRestart = vi.fn(() => ({ status: "failed" as const }));
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        scheduleGatewayRestart({
          delayMs: 0,
          reason: "config.patch",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit, emitRestart: staleEmitRestart },
        });
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        expect(beforeEmit).toHaveBeenCalledTimes(1);

        const update = scheduleGatewayRestart({
          delayMs: 0,
          reason: "update.auto",
          successorOwner: managedSuccessorOwner,
          skipDeferral: true,
        });
        expect(update.coalesced).toBe(true);

        releasePreparation();
        await vi.advanceTimersByTimeAsync(0);

        expect(staleEmitRestart).not.toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
        expect(peekGatewayRestartReason()).toBe("update.auto");
        expect(consumeGatewayRestartIntent()).toEqual({
          reason: "update.auto",
          successorOwner: managedSuccessorOwner,
        });
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it.each([
      { name: "ordinary earlier restart", delayMs: 0, reason: "config.patch", replace: false },
      { name: "coalesced replacement", delayMs: 1_000, reason: "update.auto", replace: true },
    ])("retains the correct managed successor for $name", async ({ delayMs, reason, replace }) => {
      const replacementOwner = { ...managedSuccessorOwner, handoffId: "replacement-handoff" };
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        scheduleGatewayRestart({
          delayMs: 1_000,
          reason: "update.auto",
          successorOwner: managedSuccessorOwner,
        });
        const next = scheduleGatewayRestart({
          delayMs,
          reason,
          ...(replace ? { successorOwner: replacementOwner } : {}),
        });
        if (replace) {
          expect(next.coalesced).toBe(true);
        }
        await vi.advanceTimersByTimeAsync(delayMs);
        expect(peekGatewayRestartReason()).toBe("update.auto");
        expect(consumeGatewayRestartIntent()).toEqual({
          reason: "update.auto",
          successorOwner: replace ? replacementOwner : managedSuccessorOwner,
        });
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("runs restart preparation only when the scheduled restart emits", async () => {
      const beforeEmit = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        scheduleGatewayRestart({
          delayMs: 1_000,
          emitHooks: { beforeEmit },
        });

        await vi.advanceTimersByTimeAsync(999);
        expect(beforeEmit).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(beforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("uses the latest preparation hook when scheduled restarts coalesce", async () => {
      const firstBeforeEmit = vi.fn(async () => {});
      const latestBeforeEmit = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        const first = scheduleGatewayRestart({
          delayMs: 1_000,
          reason: "first",
          emitHooks: { beforeEmit: firstBeforeEmit },
        });
        const second = scheduleGatewayRestart({
          delayMs: 1_000,
          reason: "second",
          emitHooks: { beforeEmit: latestBeforeEmit },
        });

        expect(first.coalesced).toBe(false);
        expect(second.coalesced).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(firstBeforeEmit).not.toHaveBeenCalled();
        expect(latestBeforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("reports emitHooksQueued=false for hookless coalesced restart requests", () => {
      const first = scheduleGatewayRestart({ delayMs: 1_000, reason: "first" });
      const second = scheduleGatewayRestart({ delayMs: 1_000, reason: "second" });

      expect(first.coalesced).toBe(false);
      expect(first.emitHooksQueued).toBe(false);
      expect(second.coalesced).toBe(true);
      expect(second.emitHooksQueued).toBe(false);
    });

    it.each([
      { session: "session-B", delayMs: 1_000, accepted: false },
      { session: "session-B", delayMs: 0, accepted: false },
      { session: "session-A", delayMs: 1_000, accepted: true },
    ])(
      "enforces hook ownership for $session rescheduled at $delayMs ms (#86742)",
      async ({ session, delayMs, accepted }) => {
        const sessionAHooks = vi.fn(async () => {});
        const sessionBHooks = vi.fn(async () => {});
        const emitSpy = vi.spyOn(process, "emit");
        const handler = () => {};
        process.on("SIGUSR2", handler);
        try {
          const first = scheduleGatewayRestart({
            delayMs: 1_000,
            reason: "session-A",
            sessionKey: "agent:main:session-A",
            emitHooks: { beforeEmit: sessionAHooks },
          });
          const second = scheduleGatewayRestart({
            delayMs,
            reason: "session-B",
            sessionKey: `agent:main:${session}`,
            emitHooks: { beforeEmit: sessionBHooks },
          });

          expect(first.coalesced).toBe(false);
          expect(first.emitHooksQueued).toBe(true);
          expect(second.coalesced).toBe(true);
          expect(second.emitHooksQueued).toBe(accepted);
          expect(second.delayMs).toBe(delayMs);

          await vi.advanceTimersByTimeAsync(delayMs);

          expect(sessionAHooks).toHaveBeenCalledTimes(accepted ? 0 : 1);
          expect(sessionBHooks).toHaveBeenCalledTimes(accepted ? 1 : 0);
          expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
        } finally {
          process.removeListener("SIGUSR2", handler);
        }
      },
    );

    it("rejects coalesced emit hooks from a different session while preparation is in flight (#86742)", async () => {
      // Pins the CWE-200 in-flight preparation race: pendingRestartSessionKey
      // must stay alive through await beforeEmit(), otherwise a coalesced
      // different-session caller slips past canReplacePendingRestartEmitHooks
      // and chains its own hooks while preparation runs.
      const { promise: sessionAPrepBlocked, resolve: releaseSessionAPrep } = createDeferred();
      const sessionAHooks = vi.fn(async () => {
        await sessionAPrepBlocked;
      });
      const sessionBHooks = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        const first = scheduleGatewayRestart({
          delayMs: 1_000,
          reason: "session-A",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit: sessionAHooks },
        });
        // Advance the scheduled timer so session A's beforeEmit starts and
        // pendingRestartPreparing becomes true; the hook awaits forever until
        // we resolve sessionAPrepBlocked below.
        await vi.advanceTimersByTimeAsync(1_000);
        await Promise.resolve();
        expect(sessionAHooks).toHaveBeenCalledTimes(1);

        // Session B coalesces *during* session A's beforeEmit await window.
        const second = scheduleGatewayRestart({
          delayMs: 1_000,
          reason: "session-B",
          sessionKey: "agent:main:session-B",
          emitHooks: { beforeEmit: sessionBHooks },
        });

        expect(first.emitHooksQueued).toBe(true);
        expect(second.coalesced).toBe(true);
        expect(second.emitHooksQueued).toBe(false);

        releaseSessionAPrep();
        await Promise.resolve();
        await Promise.resolve();

        // Session B's hook must NOT run — the guard kept session A as owner
        // through the in-flight preparation window.
        expect(sessionBHooks).not.toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("keeps existing preparation hook when a hookless restart coalesces", async () => {
      const beforeEmit = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        scheduleGatewayRestart({
          delayMs: 1_000,
          emitHooks: { beforeEmit },
        });
        const second = scheduleGatewayRestart({
          delayMs: 1_000,
          reason: "hookless",
        });

        expect(second.coalesced).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(beforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("keeps restart requests coalesced while preparation is in flight", async () => {
      let releaseFirstPrep: () => void = () => {};
      const firstRollback = vi.fn(async () => {});
      const firstBeforeEmit = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstPrep = resolve;
          }),
      );
      const latestBeforeEmit = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        scheduleGatewayRestart({
          delayMs: 1_000,
          reason: "first",
          emitHooks: {
            beforeEmit: firstBeforeEmit,
            afterEmitRejected: firstRollback,
          },
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(firstBeforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR2");

        const second = scheduleGatewayRestart({
          delayMs: 1_000,
          reason: "second",
          emitHooks: { beforeEmit: latestBeforeEmit },
        });
        expect(second.coalesced).toBe(true);

        releaseFirstPrep();
        await vi.advanceTimersByTimeAsync(0);

        expect(firstRollback).toHaveBeenCalledTimes(1);
        expect(latestBeforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it.each([
      { failure: "message getter", expectedError: "Error" },
      { failure: "formatter", expectedError: "Unknown error" },
      { failure: "logger", expectedError: "Error" },
    ])(
      "rolls back prepared restart state when emission is rejected despite $failure failure",
      async ({ failure, expectedError }) => {
        const beforeEmit = vi.fn(async () => {});
        const hookFailure = new Error();
        Object.defineProperty(hookFailure, "message", {
          get() {
            throw new Error("message read failed");
          },
        });
        const formatter = vi.spyOn(errorFormatting, "formatErrorMessage");
        if (failure === "formatter") {
          formatter.mockImplementationOnce(() => {
            throw new Error("formatting failed");
          });
        }
        if (failure === "logger") {
          restartLogWarnMock.mockImplementationOnce(() => {
            throw new Error("logging failed");
          });
        }
        const afterEmitRejected = vi.fn(async () => {
          throw hookFailure;
        });
        const afterEmitFailed = vi.fn(async () => {});
        process.once("SIGUSR2", () => {
          throw new Error("no signal");
        });

        scheduleGatewayRestart({
          delayMs: 0,
          emitHooks: { beforeEmit, afterEmitRejected, afterEmitFailed },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(beforeEmit).toHaveBeenCalledTimes(1);
        expect(afterEmitRejected).toHaveBeenCalledTimes(1);
        expect(afterEmitFailed).toHaveBeenCalledTimes(1);
        expect(formatter).toHaveBeenCalledExactlyOnceWith(hookFailure);
        expect(restartLogWarnMock).toHaveBeenCalledExactlyOnceWith(
          "restart hook callback failed; restart will continue",
          {
            hook: "afterEmitRejected",
            error: expectedError,
          },
        );
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
        const root = tryBeginGatewayRootWorkAdmission();
        expect(root).not.toBeNull();
        root?.release();
      },
    );

    it.each(["emitted", "coalesced"] as const)(
      "drains and settles parked emit hooks when hooked emission is %s",
      async (status) => {
        const parkedBeforeEmit = vi.fn(async () => {});
        const parkedAfterEmitRejected = vi.fn(async () => {});
        const callerBeforeEmit = vi.fn(async () => {});
        const callerAfterEmitRejected = vi.fn(async () => {});
        const callerEmitRestart = vi.fn(() => ({ status }));
        const handler = () => {};
        process.on("SIGUSR2", handler);
        try {
          const scheduled = scheduleGatewayRestart({
            delayMs: 60_000,
            reason: "gateway.tool.restart",
            sessionKey: "agent:main:session-A",
            emitHooks: {
              beforeEmit: parkedBeforeEmit,
              afterEmitRejected: parkedAfterEmitRejected,
            },
          });
          expect(scheduled.emitHooksQueued).toBe(true);
          deferGatewayRestartUntilIdle({
            getPendingCount: () => 0,
            reason: "config.reload",
            emitHooks: {
              beforeEmit: callerBeforeEmit,
              afterEmitRejected: callerAfterEmitRejected,
              emitRestart: callerEmitRestart,
            },
          });
          await vi.advanceTimersByTimeAsync(0);

          expect(parkedBeforeEmit).toHaveBeenCalledTimes(1);
          expect(callerBeforeEmit).toHaveBeenCalledTimes(1);
          expect(callerEmitRestart).toHaveBeenCalledTimes(1);
          // Caller preparation runs before draining parked hooks and emitting.
          expect(callerBeforeEmit.mock.invocationCallOrder[0]).toBeLessThan(
            parkedBeforeEmit.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
          );
          expect(parkedBeforeEmit.mock.invocationCallOrder[0]).toBeLessThan(
            callerEmitRestart.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
          );
          expect(parkedAfterEmitRejected).toHaveBeenCalledTimes(status === "emitted" ? 0 : 1);
          expect(callerAfterEmitRejected).toHaveBeenCalledTimes(status === "emitted" ? 0 : 1);
          if (status === "emitted") {
            const followUp = scheduleGatewayRestart({
              delayMs: 1_000,
              reason: "session-B",
              sessionKey: "agent:main:session-B",
              emitHooks: { beforeEmit: vi.fn(async () => {}) },
            });
            expect(followUp.emitHooksQueued).toBe(true);
          }
        } finally {
          process.removeListener("SIGUSR2", handler);
        }
      },
    );

    it("re-drains hooks accepted while caller preparation awaits", async () => {
      // scheduleGatewayRestart is not fence-gated: a session can park
      // hooks (emitHooksQueued: true) while the emitting caller's beforeEmit
      // awaits. Those hooks must ride this restart, not be silently dropped.
      const lateBeforeEmit = vi.fn(async () => {});
      const callerEmitRestart = vi.fn(() => ({ status: "emitted" as const }));
      let lateQueued: boolean | undefined;
      const callerBeforeEmit = vi.fn(async () => {
        if (lateQueued === undefined) {
          lateQueued = scheduleGatewayRestart({
            delayMs: 60_000,
            reason: "late.session",
            sessionKey: "agent:main:session-late",
            emitHooks: { beforeEmit: lateBeforeEmit },
          }).emitHooksQueued;
        }
      });
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        deferGatewayRestartUntilIdle({
          getPendingCount: () => 0,
          reason: "config.reload",
          emitHooks: {
            beforeEmit: callerBeforeEmit,
            emitRestart: callerEmitRestart,
          },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(lateQueued).toBe(true);
        expect(lateBeforeEmit).toHaveBeenCalledTimes(1);
        expect(callerEmitRestart).toHaveBeenCalledTimes(1);
        expect(lateBeforeEmit.mock.invocationCallOrder[0]).toBeLessThan(
          callerEmitRestart.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
        );
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("runs every afterEmitFailed callback even when an earlier one throws", async () => {
      const parkedAfterEmitFailed = vi.fn(async () => {
        throw new Error("sentinel cleanup failed");
      });
      const callerAfterEmitFailed = vi.fn(async () => {});
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        scheduleGatewayRestart({
          delayMs: 60_000,
          reason: "gateway.tool.restart",
          sessionKey: "agent:main:session-A",
          emitHooks: {
            beforeEmit: vi.fn(async () => {}),
            afterEmitFailed: parkedAfterEmitFailed,
          },
        });

        deferGatewayRestartUntilIdle({
          getPendingCount: () => 0,
          reason: "config.reload",
          emitHooks: {
            beforeEmit: vi.fn(async () => {}),
            afterEmitFailed: callerAfterEmitFailed,
            emitRestart: () => ({ status: "failed" as const }),
          },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(parkedAfterEmitFailed).toHaveBeenCalledTimes(1);
        expect(callerAfterEmitFailed).toHaveBeenCalledTimes(1);
        expect(restartLogWarnMock).toHaveBeenCalledWith(
          "restart hook callback failed; restart will continue",
          {
            hook: "afterEmitFailed",
            error: "sentinel cleanup failed",
          },
        );
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("still emits restart when preparation fails", async () => {
      const beforeEmit = vi.fn(async () => {
        throw new Error("state dir readonly");
      });
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        scheduleGatewayRestart({
          delayMs: 0,
          emitHooks: { beforeEmit },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(beforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("applies restart cooldown between emitted restart cycles", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        expect(consumeGatewayRestartAuthorization()).toBe(false);
        const first = scheduleGatewayRestart({ delayMs: 0, reason: "first" });
        expect(first.coalesced).toBe(false);
        expect(first.delayMs).toBe(0);
        expect(consumeGatewayRestartAuthorization()).toBe(false);

        await vi.advanceTimersByTimeAsync(0);
        expect(consumeGatewayRestartAuthorization()).toBe(true);
        expect(consumeGatewayRestartAuthorization()).toBe(false);
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
        markGatewayRestartHandled();
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
        const root = tryBeginGatewayRootWorkAdmission();
        expect(root).not.toBeNull();
        root?.release();

        const second = scheduleGatewayRestart({ delayMs: 0, reason: "second" });
        expect(second.coalesced).toBe(false);
        expect(second.delayMs).toBe(30_000);
        expect(second.cooldownMsApplied).toBe(30_000);

        await vi.advanceTimersByTimeAsync(29_999);
        expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(2);
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("admits another restart after its cooldown expires", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        scheduleGatewayRestart({ delayMs: 0, reason: "first" });
        await vi.advanceTimersByTimeAsync(0);
        expect(consumeGatewayRestartAuthorization()).toBe(true);
        markGatewayRestartHandled();
        await vi.advanceTimersByTimeAsync(30_000);

        const next = scheduleGatewayRestart({
          delayMs: 0,
          reason: "update.run",
        });

        expect(next.coalesced).toBe(false);
        expect(next.delayMs).toBe(0);
        expect(next.cooldownMsApplied).toBe(0);

        await vi.advanceTimersByTimeAsync(0);
        expect(countRestartSignalEmits(emitSpy.mock.calls)).toBe(2);
        expect(peekGatewayRestartReason()).toBe("update.run");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });
  });

  describe("pre-restart deferral check", () => {
    setupRestartSignalSuite();

    it("emits SIGUSR2 immediately when no deferral check is registered", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        scheduleGatewayRestart({ delayMs: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("emits SIGUSR2 immediately when deferral check returns 0", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        setPreRestartDeferralCheck(() => 0);
        scheduleGatewayRestart({ delayMs: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it.each(["drained", "timed out"])("defers SIGUSR2 until work is %s", async (outcome) => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        let pending = 2;
        setPreRestartDeferralCheck(() => pending);
        scheduleGatewayRestart({ delayMs: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR2");
        if (outcome === "drained") {
          await vi.advanceTimersByTimeAsync(500);
          expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR2");
          pending = 0;
          await vi.advanceTimersByTimeAsync(500);
        } else {
          await vi.advanceTimersByTimeAsync(300_000);
        }
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it("bypasses the pre-restart deferral check when requested", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const pendingCheck = vi.fn(() => 5);
      const handler = () => {};
      process.on("SIGUSR2", handler);
      try {
        setPreRestartDeferralCheck(pendingCheck);
        scheduleGatewayRestart({
          delayMs: 0,
          reason: "update.run",
          skipDeferral: true,
        });

        await vi.advanceTimersByTimeAsync(0);

        expect(pendingCheck).not.toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
        expect(peekGatewayRestartReason()).toBe("update.run");
      } finally {
        process.removeListener("SIGUSR2", handler);
      }
    });

    it.each([
      {
        phase: "pending timer",
        delayMs: 1_000,
        sessionKey: "agent:main:session-A",
        preserve: true,
      },
      { phase: "active deferral", delayMs: 0, sessionKey: "agent:main:session-A", preserve: true },
      {
        phase: "session-owned deferral",
        delayMs: 0,
        sessionKey: "agent:main:session-A",
        preserve: false,
      },
      { phase: "unowned deferral", delayMs: 0, sessionKey: undefined, preserve: false },
    ])(
      "bypasses $phase with preservePendingEmitHooks=$preserve (#86742)",
      async ({ delayMs, sessionKey, preserve }) => {
        const emitSpy = vi.spyOn(process, "emit");
        const beforeEmit = vi.fn(async () => {});
        const pendingCheck = vi.fn(() => 5);
        const handler = () => {};
        process.on("SIGUSR2", handler);
        try {
          setPreRestartDeferralCheck(pendingCheck);
          const pending = scheduleGatewayRestart({
            delayMs,
            reason: "session-A",
            sessionKey,
            emitHooks: { beforeEmit },
          });
          if (delayMs === 0) {
            await vi.advanceTimersByTimeAsync(0);
            expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR2");
          }
          const reason = preserve ? "gateway.restart.safe" : "update.run";
          const forced = scheduleGatewayRestart({
            delayMs,
            preservePendingEmitHooksOnDeferralBypass: preserve,
            reason,
            skipDeferral: true,
            ...(sessionKey === undefined ? { successorOwner: managedSuccessorOwner } : {}),
          });

          expect(pending.emitHooksQueued).toBe(true);
          expect(forced.coalesced).toBe(false);
          expect(forced.emitHooksQueued).toBe(false);
          if (delayMs === 0) {
            expect(beforeEmit).toHaveBeenCalledTimes(preserve ? 1 : 0);
          }
          if (delayMs > 0) {
            await vi.advanceTimersByTimeAsync(delayMs);
            expect(pendingCheck).not.toHaveBeenCalled();
          } else {
            await Promise.resolve();
            await Promise.resolve();
          }
          expect(beforeEmit).toHaveBeenCalledTimes(preserve ? 1 : 0);
          expect(emitSpy).toHaveBeenCalledWith("SIGUSR2");
          expect(peekGatewayRestartReason()).toBe(reason);
          if (sessionKey === undefined) {
            expect(consumeGatewayRestartIntent()).toEqual({
              reason,
              successorOwner: managedSuccessorOwner,
            });
          }
        } finally {
          process.removeListener("SIGUSR2", handler);
        }
      },
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
