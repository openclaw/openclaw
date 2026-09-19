/** Shutdown request reasons and installation-replacement handoff cases share the run-loop fixture. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi, type Mock } from "vitest";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createRuntimeWithExitSignal,
  createSignaledStart,
  waitForStart,
  waitForLoopCondition,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

type RequestFixtures = {
  acquireGatewayLock: Mock<
    (opts?: { port?: number }) => Promise<{ release: Mock<() => Promise<void>> }>
  >;
  reloadTaskRuntimeStateFromStore: Mock<() => Promise<void>>;
  runLoopWithStart: (params: {
    start: ReturnType<typeof createSignaledStart>["start"];
    runtime: ReturnType<typeof createRuntimeWithExitSignal>["runtime"];
    completeBoot?: (completion: GatewayBootLifecycleCompletion) => void;
  }) => Promise<unknown>;
  waitForGatewayActiveWork: Mock<
    typeof import("../../infra/gateway-active-work.js").waitForGatewayActiveWork
  >;
  restartGatewayProcessWithFreshPid: Mock<
    typeof import("../../infra/process-respawn.js").restartGatewayProcessWithFreshPid
  >;
  consumeGatewaySigusr1RestartIntent: Mock<() => GatewayRestartIntent | null>;
  consumeGatewayRestartIntentPayloadSync: Mock<
    () => Pick<GatewayRestartIntent, "reason" | "force" | "waitMs"> | null
  >;
  peekGatewaySigusr1RestartReason: Mock<() => string | undefined>;
  managedUpdateSuccessorOwner: NonNullable<GatewayRestartIntent["successorOwner"]>;
  commitManagedServiceUpdateHandoff: Mock<
    typeof import("../../infra/update-managed-service-handoff.js").commitManagedServiceUpdateHandoff
  >;
  isGatewayWorkAdmissionClosed: () => boolean;
  gatewayLog: { info: Mock; error: Mock };
};

export function registerGatewayRequestTests({
  acquireGatewayLock,
  reloadTaskRuntimeStateFromStore,
  runLoopWithStart,
  waitForGatewayActiveWork,
  restartGatewayProcessWithFreshPid,
  consumeGatewaySigusr1RestartIntent,
  consumeGatewayRestartIntentPayloadSync,
  peekGatewaySigusr1RestartReason,
  managedUpdateSuccessorOwner,
  commitManagedServiceUpdateHandoff,
  isGatewayWorkAdmissionClosed,
  gatewayLog,
}: RequestFixtures): void {
  const idleActiveWorkSnapshot = createActiveWorkSnapshot();
  it.each(["lock", "restart-cleanup"] as const)(
    "does not resume a replaced runtime when replacement arrives during %s",
    async (phase) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, started } = createSignaledStart(createCloseMock());
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        await runLoopWithStart({ start, runtime, completeBoot });
        await waitForStart(started);
        const reached = createDeferredCore();
        const resume = createDeferredCore();
        if (phase === "lock") {
          acquireGatewayLock.mockImplementationOnce(async () => {
            reached.resolve();
            await resume.promise;
            return { release: vi.fn(async () => {}) };
          });
        } else {
          reloadTaskRuntimeStateFromStore.mockImplementationOnce(async () => {
            reached.resolve();
            await resume.promise;
          });
        }
        try {
          captureSignal("SIGUSR1")();
          await reached.promise;
          const { classifyGatewayStaleInstall } = await import("../../gateway/stale-install.js");
          classifyGatewayStaleInstall(
            Object.assign(new Error("replaced runtime"), {
              code: "ENOENT",
              path: fileURLToPath(new URL("../../gateway/missing-runtime.js", import.meta.url)),
            }),
          );
          resume.resolve();
          await waitForLoopCondition(
            () => start.mock.calls.length > 1 || runtime.exit.mock.calls.length > 0,
            "replacement did not settle the old process",
          );
          expect(start).toHaveBeenCalledOnce();
          await expect(exited).resolves.toBe(1);
          expect(completeBoot).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              reason: expect.stringContaining("gateway.installation_replaced"),
            }),
          );
        } finally {
          resume.resolve();
          if (!runtime.exit.mock.calls.length) {
            captureSignal("SIGINT")();
            await exited;
          }
        }
      });
    },
  );
  it.each([
    "systemd",
    "foreground",
    "failed-handoff",
    "existing-restart",
    "existing-stop",
    "managed-update",
    "failed-close",
  ] as const)(
    "settles an own-chunk failure before handing over a replaced installation (%s)",
    async (mode) => {
      const supervised = ["systemd", "failed-handoff", "managed-update", "failed-close"].includes(
        mode,
      );
      if (supervised) {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      }
      restartGatewayProcessWithFreshPid.mockReturnValue(
        mode === "failed-close"
          ? { mode: "supervised", exitCode: 131071 }
          : mode === "systemd"
            ? { mode: "supervised" }
            : mode === "failed-handoff"
              ? { mode: "failed", detail: "handoff unavailable" }
              : { mode: "disabled", detail: "unmanaged" },
      );
      const drainStarted = createDeferredCore();
      const drain = createDeferredCore<{ drained: boolean; snapshot: GatewayActiveWorkSnapshot }>();
      waitForGatewayActiveWork.mockImplementationOnce(() => {
        drainStarted.resolve();
        return drain.promise;
      });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = createCloseMock();
        if (mode === "failed-close") {
          close.mockRejectedValueOnce(new Error("old plugin chunk unavailable during close"));
        }
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        await runLoopWithStart({ start, runtime, completeBoot });
        await waitForStart(started);
        const { classifyGatewayStaleInstall } = await import("../../gateway/stale-install.js");
        const missingChunk = fileURLToPath(
          new URL("../../gateway/missing-runtime.js", import.meta.url),
        );
        try {
          if (mode === "managed-update") {
            consumeGatewaySigusr1RestartIntent.mockReturnValueOnce({
              reason: "update.run",
              successorOwner: managedUpdateSuccessorOwner,
            });
          }
          if (
            mode === "existing-restart" ||
            mode === "existing-stop" ||
            mode === "managed-update"
          ) {
            captureSignal(mode === "existing-stop" ? "SIGINT" : "SIGUSR1")();
            await drainStarted.promise;
          }
          classifyGatewayStaleInstall(
            Object.assign(new Error("Cannot find module"), {
              code: "ERR_MODULE_NOT_FOUND",
              url: pathToFileURL(missingChunk).href,
            }),
          );
          expect(isGatewayWorkAdmissionClosed()).toBe(true);
          expect(close).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
          await expect(exited).resolves.toBe(
            mode === "failed-close"
              ? 131071
              : mode === "systemd" || mode === "existing-stop" || mode === "managed-update"
                ? 0
                : 1,
          );
          expect(close).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledOnce();
          expect(completeBoot).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome:
                mode === "failed-close"
                  ? "forced_stop"
                  : mode === "existing-stop"
                    ? "clean_stop"
                    : "planned_restart",
              reason: expect.stringContaining("gateway.installation_replaced"),
            }),
          );
          if (!supervised) {
            expect(gatewayLog.error).toHaveBeenCalledWith(
              expect.stringContaining("openclaw gateway run"),
            );
          }
          if (mode === "managed-update") {
            expect(commitManagedServiceUpdateHandoff).toHaveBeenCalledWith(
              managedUpdateSuccessorOwner,
              "update",
            );
            expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
          }
        } finally {
          drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
          if (!runtime.exit.mock.calls.length) {
            captureSignal("SIGINT")();
            await exited;
          }
        }
      });
    },
  );

  it.each([
    { signal: "SIGTERM", restartReason: undefined, reason: "stop (SIGTERM)" },
    { signal: "SIGINT", restartReason: undefined, reason: "stop (SIGINT)" },
    { signal: "SIGUSR1", restartReason: undefined, reason: "restart (SIGUSR1)" },
    {
      signal: "SIGUSR1",
      restartReason: "config reload: gateway.bind",
      reason: "restart (SIGUSR1: config reload: gateway.bind)",
    },
    {
      signal: "SIGTERM",
      restartReason: "update.run",
      reason: "restart (SIGTERM: update.run)",
    },
  ] as const)("names the shutdown trigger: $reason", async ({ signal, restartReason, reason }) => {
    vi.clearAllMocks();
    if (signal === "SIGTERM" && restartReason) {
      consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ reason: restartReason });
    } else {
      peekGatewaySigusr1RestartReason.mockReturnValueOnce(restartReason);
    }
    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = createCloseMock();
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      await runLoopWithStart({ start, runtime, completeBoot });
      await waitForStart(started);
      captureSignal(signal)();
      if (signal === "SIGUSR1") {
        await waitForLoopCondition(() => start.mock.calls.length === 2, "restart did not finish");
        captureSignal("SIGINT")();
      }
      await expect(exited).resolves.toBe(0);
      expect(gatewayLog.info).toHaveBeenCalledWith(`admission closed: ${reason}`);
      expect(gatewayLog.info).not.toHaveBeenCalledWith("admission closed: restart drain");
      expect(completeBoot).toHaveBeenCalledWith({
        outcome: reason.startsWith("restart") ? "planned_restart" : "clean_stop",
        reason,
      });
    });
  });
}
