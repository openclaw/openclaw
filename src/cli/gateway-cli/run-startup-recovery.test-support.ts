import { expect, it, vi, type Mock } from "vitest";
import type { GatewayServerOptions } from "../../gateway/server-public.js";
import type { GatewayCrashLoopBreakerDecision } from "../../infra/gateway-boot-lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import type { GatewayLoopParams } from "./run-cleanup-receipt.test-support.js";

type BootDecision = Pick<
  GatewayCrashLoopBreakerDecision,
  "tripped" | "uncleanBoots" | "windowMs" | "shouldWriteStabilityBundle" | "recovered"
>;

export function registerGatewayRunStartupRecoveryTests({
  bootLifecycle,
  bootDecision,
  runGatewayLoop,
  gatewayStartOptions,
  runUnconfigured,
  writeDiagnosticStabilityBundleForFailureSync,
  gatewayLogMessages,
  triageAfterFailure,
  detectRespawnSupervisor,
  expectExit,
  defaultRuntime,
  runtimeErrors,
  runGatewayCli,
  withoutSupervisorEnv,
  startGatewayServer,
  configState,
}: {
  startGatewayServer: Mock<(port: number, opts?: unknown) => Promise<unknown>>;
  configState: { snapshot: Record<string, unknown> };
  bootLifecycle: {
    nextBootId: Mock<() => string | undefined>;
    decisions: BootDecision[];
    complete: Mock;
    inspect: Mock<(env?: NodeJS.ProcessEnv, nowMs?: number) => BootDecision>;
    begin: Mock<
      (
        env?: NodeJS.ProcessEnv,
        nowMs?: number,
      ) => Promise<{ id: string | undefined; decision: BootDecision }>
    >;
    recover: Mock<
      (
        _bootId?: string,
        _env?: NodeJS.ProcessEnv,
        _nowMs?: number,
        _assertCurrent?: () => void,
      ) => Promise<string | undefined>
    >;
    manualChannelStartHint: string;
  };
  bootDecision: (tripped?: boolean, recovered?: boolean) => BootDecision;
  runGatewayLoop: Mock<(params: GatewayLoopParams) => Promise<void>>;
  gatewayStartOptions: (index?: number) => GatewayServerOptions;
  runUnconfigured: (...args: string[]) => Promise<void>;
  writeDiagnosticStabilityBundleForFailureSync: Mock;
  gatewayLogMessages: string[];
  triageAfterFailure: Mock<() => Promise<undefined>>;
  detectRespawnSupervisor: Mock<() => "systemd" | null>;
  expectExit: (code: number, ...args: string[]) => Promise<unknown>;
  defaultRuntime: typeof import("../../runtime.js").defaultRuntime;
  runtimeErrors: string[];
  runGatewayCli: (argv: string[]) => Promise<void>;
  withoutSupervisorEnv: Record<string, string | undefined>;
}) {
  it("refreshes config and crash-loop state for each boot iteration", async () => {
    let firstBootRecovery: GatewayServerOptions["tryRecoverChannelAutostartSuppression"];
    bootLifecycle.nextBootId.mockReturnValueOnce("boot-1").mockReturnValueOnce("boot-2");
    const persistence = createDeferredCore();
    bootLifecycle.complete.mockReturnValueOnce(persistence.promise);
    runGatewayLoop.mockImplementationOnce(
      async ({ beginBoot, completeBoot, start }: GatewayLoopParams) => {
        await beginBoot?.(1000);
        await start({ startupStartedAt: 1000 });
        firstBootRecovery = gatewayStartOptions(0).tryRecoverChannelAutostartSuppression;
        const completion = completeBoot?.({ outcome: "startup_failed", reason: "NeedsLogin" });
        try {
          await completeBoot?.({
            outcome: "planned_restart",
            reason: "gateway.startup_recovery_completed",
          });
          expect(bootLifecycle.complete.mock.calls.map(([bootId]) => bootId)).toEqual([
            "boot-1",
            undefined,
          ]);
        } finally {
          persistence.resolve();
        }
        await completion;
        await beginBoot?.(2000);
        await start({ startupStartedAt: 2000 });
        await completeBoot?.({ outcome: "clean_stop" });
      },
    );
    bootLifecycle.decisions.push(bootDecision(true), bootDecision(false, true));

    await runUnconfigured();

    expect(bootLifecycle.inspect).toHaveBeenCalledTimes(2);
    expect(bootLifecycle.inspect.mock.calls.map((call) => call[1])).toEqual([1000, 2000]);
    expect(bootLifecycle.begin.mock.calls.map((call) => call[1])).toEqual([1000, 2000]);
    expect(bootLifecycle.complete.mock.calls).toEqual([
      ["boot-1", { outcome: "startup_failed", reason: "NeedsLogin" }, process.env],
      [
        undefined,
        { outcome: "planned_restart", reason: "gateway.startup_recovery_completed" },
        process.env,
      ],
      ["boot-2", { outcome: "clean_stop" }, process.env],
    ]);
    expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledTimes(1);
    expect(gatewayStartOptions(0).channelAutostartSuppression).toMatchObject({
      reason: "crash-loop-breaker",
    });
    expect(gatewayStartOptions(0).channelAutostartSuppression?.message).toContain(
      bootLifecycle.manualChannelStartHint,
    );
    expect(gatewayStartOptions(1).channelAutostartSuppression).toBeUndefined();
    expect(startGatewayServer).toHaveBeenCalledTimes(2);
    expect(gatewayStartOptions(0).startupStartedAt).toBe(1000);
    expect(gatewayStartOptions(0).startupConfigSnapshotRead).toEqual({
      snapshot: configState.snapshot,
    });
    expect(gatewayStartOptions(1).startupConfigSnapshotRead).toBeUndefined();
    expect(gatewayStartOptions(1).startupStartedAt).toBe(2000);
    bootLifecycle.decisions.push(bootDecision(false, true));
    await expect(firstBootRecovery?.(new AbortController().signal)).rejects.toThrow(
      "replaced boot",
    );
    expect(bootLifecycle.inspect).toHaveBeenCalledTimes(2);
    expect(bootLifecycle.recover).not.toHaveBeenCalled();
    expect(gatewayLogMessages.some((message) => message.includes("breaker recovered"))).toBe(true);
  });

  it.each([
    { supervised: false, transition: false, recorded: true, attempts: 1 },
    { supervised: true, transition: false, recorded: true, attempts: 0 },
    { supervised: true, transition: true, recorded: true, attempts: 0, cleanupFailure: "wrapped" },
  ])(
    "triages failed starts once with supervisor transition gating: %j",
    async ({ supervised, transition, recorded, attempts, cleanupFailure }) => {
      triageAfterFailure.mockClear();
      detectRespawnSupervisor.mockReturnValue(supervised ? "systemd" : null);
      bootLifecycle.nextBootId.mockReturnValueOnce(recorded ? "boot-id" : undefined);
      bootLifecycle.decisions.push(bootDecision(transition));
      let failure: Error = new Error("configured plugin crashed during startup");
      if (cleanupFailure) {
        const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
        failure = new GatewayStartupCleanupError(
          failure,
          new Error("required cleanup unconfirmed"),
        );
        if (cleanupFailure === "wrapped") {
          failure = new Error("startup wrapper failed", { cause: failure });
        }
      }
      runGatewayLoop.mockImplementationOnce(async (params: GatewayLoopParams) => {
        await params.beginBoot?.(1000);
        // Repeated in-process failures and the terminal catch share one handoff.
        await params.onRestartStartupFailure?.(failure, new AbortController().signal);
        await params.onRestartStartupFailure?.(failure, new AbortController().signal);
        throw failure;
      });
      await expectExit(1);
      expect(triageAfterFailure).toHaveBeenCalledTimes(attempts);
      if (attempts) {
        expect(triageAfterFailure).toHaveBeenCalledWith(
          defaultRuntime,
          expect.objectContaining({
            kind: "gateway-startup",
            error: failure.message,
            gateway: "verify-running",
          }),
          expect.any(AbortSignal),
        );
      }
      expect(runtimeErrors.join("\n")).toContain(failure.message);
    },
  );

  it.each([
    {
      label: "an external supervisor",
      env: { OPENCLAW_SUPERVISOR_MODE: "external" },
      recovers: true,
    },
    {
      label: "the Linux Gateway service marker",
      env: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      recovers: true,
    },
    { label: "a foreground process", env: {}, recovers: false },
  ])(
    "starts Tailscale Serve prerequisite recovery only under supervision: $label",
    async ({ env, recovers }) => {
      const tailscaleBackend = await import("../../infra/tailscale-backend-ready.js");
      const waitForBackend = vi
        .spyOn(tailscaleBackend, "waitForTailscaleBackendRunning")
        .mockResolvedValue(true);
      const { TailscaleBackendAuthenticationRequiredError } = tailscaleBackend;
      const failure = new TailscaleBackendAuthenticationRequiredError("NeedsLogin", "serve", {
        bin: "tailscale",
        prefix: [],
      });
      let recoverStartupFailure: GatewayLoopParams["onRestartStartupFailure"];
      runGatewayLoop.mockImplementationOnce(async (params: GatewayLoopParams) => {
        recoverStartupFailure = params.onRestartStartupFailure;
      });

      try {
        await withMockedPlatform("linux", () =>
          withEnvAsync({ ...withoutSupervisorEnv, ...env }, async () => {
            await runGatewayCli(["gateway", "run", "--allow-unconfigured", "--tailscale", "serve"]);
            expect(recoverStartupFailure).toBeTypeOf("function");
            const signal = new AbortController().signal;
            const outcome = await recoverStartupFailure?.(failure, signal);
            expect(outcome).toBe(recovers ? "completed" : undefined);
            if (recovers) {
              expect(waitForBackend).toHaveBeenCalledOnce();
              expect(waitForBackend).toHaveBeenCalledWith({
                bin: "tailscale",
                prefix: [],
                signal,
                info: expect.any(Function),
              });
            } else {
              expect(waitForBackend).not.toHaveBeenCalled();
            }
          }),
        );
      } finally {
        waitForBackend.mockRestore();
      }
    },
  );
}
