import { performance } from "node:perf_hooks";
import { expect, it, vi, type Mock } from "vitest";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../../daemon/launchd-plist.js";
import { buildSystemdUnit } from "../../daemon/systemd-unit.js";
import { GatewayConnectionWork } from "../../gateway/server-connection-work.js";
import type { GatewayServer } from "../../gateway/server-public.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createActiveWorkSnapshot,
  createRuntimeWithExitSignal,
  createSignaledStart,
  setPlatform,
  waitForStart,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

const shutdownBudgetCases: {
  signal: "SIGTERM" | "SIGUSR2";
  honorsAbort: boolean;
  supervisor: "systemd" | "external-systemd" | "launchd" | "foreground";
  waitMs?: number;
  installedStopMs?: number;
  shutdownStopMs?: number | "unavailable";
  inspectionMs?: number;
}[] = [
  ...([330_000, 30_000, "unavailable"] as const).map((shutdownStopMs) => ({
    signal: "SIGTERM" as const,
    honorsAbort: false,
    supervisor: "systemd" as const,
    installedStopMs: shutdownStopMs === 30_000 ? 330_000 : 30_000,
    shutdownStopMs,
    inspectionMs: 500,
  })),
  { signal: "SIGTERM", honorsAbort: false, supervisor: "systemd", installedStopMs: 90_000 },
  {
    signal: "SIGTERM",
    honorsAbort: false,
    supervisor: "external-systemd",
    installedStopMs: 90_000,
  },
  {
    signal: "SIGUSR2",
    honorsAbort: false,
    supervisor: "external-systemd",
    installedStopMs: 90_000,
  },
  { signal: "SIGTERM", honorsAbort: false, supervisor: "systemd" },
  { signal: "SIGTERM", honorsAbort: false, supervisor: "foreground" },
  { signal: "SIGTERM", honorsAbort: true, supervisor: "systemd" },
  { signal: "SIGUSR2", honorsAbort: false, supervisor: "systemd" },
  { signal: "SIGTERM", honorsAbort: false, supervisor: "launchd" },
  { signal: "SIGUSR2", honorsAbort: false, supervisor: "launchd" },
  { signal: "SIGUSR2", honorsAbort: false, supervisor: "systemd", waitMs: 0 },
  { signal: "SIGUSR2", honorsAbort: false, supervisor: "systemd", waitMs: 600_000 },
];

export function registerShutdownBudgetTests({
  runLoopWithStart,
  systemctl,
  consumeGatewayRestartIntent,
  createGatewayActiveWorkSnapshot,
  waitForGatewayActiveWork,
  gatewayLog,
  writeDiagnosticStabilityBundleForFailureSync,
}: {
  runLoopWithStart: (params: {
    start: ReturnType<typeof createSignaledStart>["start"];
    runtime: ReturnType<typeof createRuntimeWithExitSignal>["runtime"];
  }) => Promise<unknown>;
  systemctl: Mock<() => Promise<{ code: number; stdout: string; stderr: string }>>;
  consumeGatewayRestartIntent: Mock<() => GatewayRestartIntent | null>;
  createGatewayActiveWorkSnapshot: Mock<() => GatewayActiveWorkSnapshot>;
  waitForGatewayActiveWork: Mock<
    typeof import("../../infra/gateway-active-work.js").waitForGatewayActiveWork
  >;
  gatewayLog: { info: Mock; warn: Mock };
  writeDiagnosticStabilityBundleForFailureSync: Mock;
}) {
  it.each(shutdownBudgetCases)(
    "bounds $supervisor $signal cleanup when a long provider call honors abort=$honorsAbort (wait=$waitMs, installedStop=$installedStopMs, shutdownStop=$shutdownStopMs)",
    async ({
      signal,
      honorsAbort,
      supervisor,
      waitMs,
      installedStopMs,
      shutdownStopMs,
      inspectionMs = 0,
    }) => {
      vi.clearAllMocks();
      const unit = buildSystemdUnit({ programArguments: ["openclaw", "gateway", "run"] });
      const stopTimeoutMs =
        supervisor === "launchd"
          ? LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000
          : ((typeof shutdownStopMs === "number" ? shutdownStopMs : installedStopMs) ??
            Number(unit.match(/^TimeoutStopSec=(\d+)$/m)?.[1]) * 1_000);
      const successStatuses = unit
        .match(/^SuccessExitStatus=(.+)$/m)?.[1]
        ?.split(" ")
        .map(Number);
      if (supervisor === "systemd" || supervisor === "external-systemd") {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
        if (supervisor === "external-systemd") {
          process.env.OPENCLAW_SUPERVISOR_MODE = "external";
        }
        setPlatform("linux");
      } else if (supervisor === "launchd") {
        process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
        setPlatform("darwin");
      }
      if (installedStopMs !== undefined) {
        systemctl.mockResolvedValue({
          code: 0,
          stdout: `LoadState=loaded\nTimeoutStopUSec=${installedStopMs / 1_000}s`,
          stderr: "",
        });
      }
      if (waitMs !== undefined) {
        consumeGatewayRestartIntent.mockReturnValueOnce({ waitMs });
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const provider = createDeferredCore();
        const connectionWork = new GatewayConnectionWork();
        void connectionWork.track(() => provider.promise);
        connectionWork.signal.addEventListener("abort", () => {
          if (honorsAbort) {
            provider.resolve();
          }
        });
        const close = vi.fn<GatewayServer["close"]>(async () => {
          await connectionWork.drain();
        });
        const { start, started } = createSignaledStart(close);
        const { runtime } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime });
        await waitForStart(started);
        const host = start.mock.calls[0]?.[0]?.hostLifecycle;
        const active = createActiveWorkSnapshot({ embeddedRuns: 1 });
        createGatewayActiveWorkSnapshot.mockReturnValue(active);
        waitForGatewayActiveWork.mockImplementationOnce(async (timeoutMs, options) => {
          options?.onSnapshot?.(active);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, timeoutMs);
          });
          return { drained: false, snapshot: active };
        });
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
        try {
          if (shutdownStopMs !== undefined) {
            const result = {
              code: shutdownStopMs === "unavailable" ? 1 : 0,
              stdout:
                shutdownStopMs === "unavailable"
                  ? ""
                  : `LoadState=loaded\nTimeoutStopUSec=${shutdownStopMs / 1_000}s`,
              stderr: shutdownStopMs === "unavailable" ? "manager unavailable" : "",
            };
            systemctl.mockResolvedValue(result).mockImplementationOnce(async () => {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, inspectionMs);
              });
              return result;
            });
          }
          if (installedStopMs !== undefined) {
            const probes = systemctl.mock.calls.length;
            expect(host?.getShutdownBudget?.()).toEqual({
              timeoutMs: installedStopMs - 5_000,
              reserveMs: 10_000,
              nativeStopBudget: true,
            });
            expect(systemctl.mock.calls).toHaveLength(probes);
          }
          setTimeout(() => provider.resolve(), 600_000);
          captureSignal(signal)();
          await vi.advanceTimersByTimeAsync(inspectionMs);
          if (installedStopMs !== undefined) {
            expect(host?.getShutdownBudget?.()).toEqual({
              timeoutMs: stopTimeoutMs - 5_000 - inspectionMs,
              reserveMs: 10_000,
              nativeStopBudget: true,
            });
            expect(waitForGatewayActiveWork).toHaveBeenCalledWith(
              stopTimeoutMs - 15_000 - inspectionMs,
              expect.any(Object),
            );
            const budgetLogs = gatewayLog.info.mock.calls
              .flat()
              .filter((line: string) => line.includes("shutdown budget at"));
            expect(budgetLogs).toEqual(
              [
                ["startup", installedStopMs - 5_000, installedStopMs],
                [
                  "shutdown",
                  stopTimeoutMs - 5_000 - inspectionMs,
                  shutdownStopMs === "unavailable" ? 90_000 : stopTimeoutMs,
                ],
              ].map(([phase, budget, source]) => {
                const origin =
                  phase === "shutdown" && shutdownStopMs === "unavailable"
                    ? `startup shutdown budget=${installedStopMs - 5_000}`
                    : `TimeoutStopUSec=${source}`;
                return expect.stringMatching(
                  new RegExp(
                    `at ${phase}: drain=${Number(budget) - 10_000}ms shutdown=${budget}ms.*${origin}ms`,
                  ),
                );
              }),
            );
            if (shutdownStopMs === "unavailable") {
              expect(gatewayLog.warn).toHaveBeenCalledWith(
                expect.stringContaining("Unable to read systemd stop timeout"),
              );
            }
          }
          const deadlineMs =
            signal === "SIGTERM" || waitMs !== undefined
              ? stopTimeoutMs - 5_000
              : Math.min(310_000, stopTimeoutMs - 5_000);
          expect(deadlineMs).toBeLessThan(stopTimeoutMs);
          await vi.advanceTimersByTimeAsync(deadlineMs - inspectionMs - 1);
          expect(connectionWork.signal.aborted).toBe(true);
          if (!honorsAbort) {
            expect(runtime.exit).not.toHaveBeenCalled();
          }
          await vi.advanceTimersByTimeAsync(1);
          const expectedExit = supervisor === "foreground" && !honorsAbort ? 1 : 0;
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(expectedExit);
          if (supervisor !== "foreground") {
            expect(successStatuses).toContain(runtime.exit.mock.calls[0]?.[0]);
          }
          expect(start).toHaveBeenCalledOnce();
          if (!honorsAbort) {
            expect(gatewayLog.warn).toHaveBeenCalledWith(
              expect.stringMatching(/abandoning.*embeddedRuns=1/),
            );
            expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
              signal === "SIGTERM"
                ? "gateway.stop_shutdown_timeout"
                : "gateway.restart_shutdown_timeout",
              undefined,
            );
          }
        } finally {
          clock.mockRestore();
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      });
    },
  );
}
