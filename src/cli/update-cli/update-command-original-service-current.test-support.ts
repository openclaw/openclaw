import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  commitDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
} from "../../daemon/runtime-pin-state.js";
import * as nativeLock from "../../daemon/service-operation-lock.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import {
  captureGatewayServiceRebind,
  currentGatewayServiceRebindReceipt,
  fingerprintGatewayServiceDefinition,
  settleGatewayServiceRebind,
  withGatewayServiceRebindCapture,
} from "../../daemon/service-rebind.js";
import * as integrity from "../../infra/package-update-integrity.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  finishParams,
  updateResult,
  updateStep,
} from "./update-command-maintenance-fixtures.test-support.js";
import type { OriginalServiceFixture } from "./update-command-original-service-fixture.test-support.js";
import { registerRuntimePinPreservationTest } from "./update-command-original-service-pins.test-support.js";
import {
  observeOriginalManagedServiceRuntime,
  revalidateOriginalManagedServiceRuntime,
} from "./update-command-original-service.js";
import { finishUpdate } from "./update-command-post-update.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import type { OriginalManagedServiceRuntime } from "./update-command-service-context-types.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-maintenance.js";
import {
  maybeRestartServiceAfterFailedMutableUpdate,
  compensateOriginalManagedService,
} from "./update-command-service-recovery.js";

type Run = NonNullable<UpdateCommandOptions["run"]>;
function expectCalls(count: number, ...mocks: Mock[]) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}

export function registerCurrentF3Controls(fixture: () => OriginalServiceFixture) {
  const admitted = async (operation: (run: Run) => Promise<void>, retained = true) => {
    const { state, rootA, rootB } = fixture();
    const run: Run = {
      runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
      env: state.env,
    };
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(rootB, retained ? { serviceRoot: rootA } : {});
      await operation(run);
    });
  };

  const observe = (run: Run, updateStepTimeoutMs?: number) =>
    observeOriginalManagedServiceRuntime(
      { root: fixture().rootB, opts: { run }, updateStepTimeoutMs },
      fixture().before,
    );
  const observed = (
    operation: (original: OriginalManagedServiceRuntime, run: Run) => Promise<void>,
    retained = true,
  ) =>
    admitted(async (run) => {
      const original = await observe(run);
      assert(original, "missing original observation");
      await operation(original, run);
    }, retained);

  const recoveryParams = (original: OriginalManagedServiceRuntime, run: Run) => ({
    opts: { run, json: true },
    originalManagedServiceRuntime: original,
    preManagedServiceStop: { ...fixture().before, stopped: true },
    allowGatewayRestart: true,
    timeoutMs: 30_000,
  });
  const restartOriginal = (original: OriginalManagedServiceRuntime, run: Run) =>
    maybeRestartServiceAfterFailedMutableUpdate({
      ...recoveryParams(original, run),
      updateRun: run,
      jsonMode: true,
    });

  registerRuntimePinPreservationTest(fixture, admitted);

  it.each(["unchanged", "replaced"] as const)(
    "capable original recovery binds definition after native lock: %s",
    async (scenario) => {
      const { state, serviceState, mocks } = fixture();
      await observed(async (original, run) => {
        mocks.capability.mockResolvedValue(true);
        const lock = nativeLock.withGatewayServiceOperationLock;
        const [held, waiting, release] = [createDeferred(), createDeferred(), createDeferred()];
        let holder: Promise<void> | undefined;
        let acquisitions = 0;
        vi.spyOn(nativeLock, "withGatewayServiceOperationLock").mockImplementation(
          async <T>(
            env: NodeJS.ProcessEnv,
            operation: (assertCurrent: () => void) => Promise<T>,
          ): Promise<T> => {
            const acquisition = ++acquisitions;
            if (acquisition === 2) {
              waiting.resolve();
            }
            const result = await lock(env, operation);
            if (acquisition === 1) {
              // Interleave a native writer between restoration and restart.
              holder = lock(env, async () => {
                held.resolve();
                await release.promise;
              });
              await held.promise;
            }
            return result;
          },
        );
        // The capable receiver's transport accepts no original-definition binding.
        mocks.restart.mockImplementation(async () =>
          nativeLock.withGatewayServiceOperationLock(state.env, async (assertCurrent) => {
            await mocks.nativeRestart({
              assertCurrent,
              preserveDefinition: true,
              preserveAutoStart: true,
            });
            return "accepted";
          }),
        );
        const settled = restartOriginal(original, run).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          await waiting.promise;
          expect(mocks.nativeRestart).not.toHaveBeenCalled();
          if (scenario === "replaced") {
            serviceState.command!.programArguments.push("--foreign-after-check");
          }
        } finally {
          release.resolve();
          await holder;
        }
        expect(await settled).toEqual({ value: scenario === "unchanged" ? "healthy" : "failed" });
        expect(mocks.nativeRestart).toHaveBeenCalledTimes(scenario === "unchanged" ? 1 : 0);
        expectCalls(0, mocks.restart);
      });
    },
  );

  it.each([
    "own-rebind-without-stop",
    "own-compensated-rebind-without-stop",
    "own-pin-rebind",
    "foreign-pin",
    "unrelated-replacement",
    "revoked",
    "schema-newer",
  ] as const)("retained own-rebind compensation: %s", async (scenario) => {
    const { state, rootA, rootB, serviceNodeRunner, before, serviceState, mocks } = fixture();
    const managedDefinition = structuredClone(serviceState.command!);
    serviceState.command = {
      ...managedDefinition,
      workingDirectory: state.home,
      managedDefinition,
      managedOverrides: {},
    };
    before.serviceUpdateVerdict = await revalidateManagedGatewayServiceAfterUpdate({
      state: serviceState,
      root: rootA,
    });
    const pinScope = { kind: "gateway" as const, env: state.env };
    const writePin = (
      nodePath: string,
      expected = readDaemonRuntimePinForInstall(pinScope, serviceState.command, true),
    ) =>
      commitDaemonRuntimePin(
        pinScope,
        {
          expected,
          pin: { runtime: "node", path: nodePath },
        },
        serviceState.command,
      );
    const pinScenario = scenario === "own-pin-rebind" || scenario === "foreign-pin";
    if (pinScenario) {
      writePin(serviceNodeRunner);
    }
    await observed(async (original, run) => {
      const originalPin = original.definition.runtimePin;
      assert(originalPin, "missing migrated pin");
      const originalCommand = structuredClone(serviceState.command!);
      const originalDigest = await fingerprintGatewayServiceDefinition(originalCommand);
      const receipt = await withGatewayServiceOperationLock(state.env, async (assertCurrent) =>
        withGatewayServiceRebindCapture(
          originalDigest,
          async () => {
            await settleGatewayServiceRebind(assertCurrent, async () => {
              await captureGatewayServiceRebind(
                async () => serviceState.command,
                assertCurrent,
                async () => {
                  serviceState.command = {
                    ...originalCommand,
                    programArguments: [
                      serviceNodeRunner,
                      path.join(rootB, "dist/index.js"),
                      "gateway",
                    ],
                  };
                  serviceState.command.managedDefinition = {
                    ...managedDefinition,
                    programArguments: serviceState.command.programArguments,
                  };
                  if (pinScenario) {
                    writePin("/selected-B-node", originalPin);
                  }
                },
                () => readDaemonRuntimePinForInstall(pinScope, null, true).revision,
              );
              if (scenario === "own-compensated-rebind-without-stop") {
                // Installer compensation restores A without restarting it.
                serviceState.command = structuredClone(originalCommand);
              }
            });
            return currentGatewayServiceRebindReceipt();
          },
          original.definition.runtimePin?.revision,
        ),
      );
      assert(receipt, "missing native receipt");
      if (scenario === "own-compensated-rebind-without-stop") {
        expect(receipt).toMatchObject({
          before: originalDigest,
          after: originalDigest,
          mutated: true,
        });
      }
      original.definition = {
        ...original.definition,
        command: originalCommand,
        fingerprint: originalDigest,
        rebound: receipt.after,
        reboundRuntimePin: receipt.runtimePinAfter,
      };
      mocks.nativeInstall.mockImplementation(async (args) => {
        await args.beforeMutation();
        args.assertCurrent();
        expect(args).toMatchObject({
          programArguments: originalCommand.programArguments,
          workingDirectory: managedDefinition.workingDirectory,
          preserveAutoStart: true,
        });
        serviceState.command = structuredClone(originalCommand);
        commitDaemonRuntimePin(pinScope, args.runtimePinUpdate, serviceState.command);
      });
      if (scenario === "foreign-pin") {
        writePin("/operator-node");
      }
      if (scenario === "unrelated-replacement") {
        assert(serviceState.command, "missing rebound command");
        serviceState.command.programArguments.push("--foreign");
      }
      if (scenario === "revoked") {
        run.executorFence = undefined;
      }
      if (scenario === "schema-newer") {
        original.schemaVersions = { state: 0, agent: 0 };
      }
      const result = updateResult({
        status: "error",
        root: rootB,
        reason: "B-health-failed",
      });
      const bytes = await fs.readFile(state.env.OPENCLAW_CONFIG_PATH!);
      const readinessBeforeRecovery = mocks.readiness.mock.calls.length;
      const recovery = {
        ...recoveryParams(original, run),
        result,
        preManagedServiceStop: { ...before, stopped: !scenario.endsWith("without-stop") },
      };
      if (scenario === "schema-newer") {
        result.reason = "state-migrated-no-rollback";
        result.recovery = { serviceRestartSafe: false, reason: "state-migration-started" };
        result.rollbackOutcome = { status: "not-attempted", reason: "Later writes must remain" };
        result.steps.push(
          updateStep("database rollback", {
            command: "restore pre-migration databases",
            cwd: state.home,
            durationMs: 0,
            stderrTail: "Restoring the backup would discard later writes",
          }),
        );
        const nativeAdmission = vi.spyOn(nativeLock, "withGatewayServiceOperationLock");
        const onGatewayStartAttempted = vi.fn();
        await expect(
          finishUpdate(
            finishParams({
              ...recovery,
              root: rootB,
              configSnapshot: await readConfigFileSnapshot({ observe: false }),
              ownedManagedUpdateEnv: state.env,
            }),
            { onGatewayStartAttempted },
          ),
        ).rejects.toMatchObject({
          result: {
            status: "error",
            reason: "state-migrated-no-rollback",
            recovery: { serviceRestartSafe: false },
          },
        });
        expect(getUpdateRun(run.runId, { env: state.env })?.verification.recovery).toMatchObject({
          serviceRestartSafe: false,
          reason: "state-migration-started",
        });
        expect(nativeAdmission).toHaveBeenCalledOnce();
        expectCalls(0, onGatewayStartAttempted, mocks.nativeRestart);
      } else {
        const outcome = compensateOriginalManagedService(recovery, () =>
          run.executorFence!.assertCurrent(),
        );
        if (scenario === "revoked") {
          await expect(outcome).rejects.toThrow();
        } else {
          expect(await outcome).toMatchObject({
            rolledBack: false,
            originalServiceRecovery: scenario.startsWith("own-") ? "healthy" : "failed",
          });
        }
      }
      const restoredByInstaller = scenario === "own-compensated-rebind-without-stop";
      expect(mocks.nativeInstall).toHaveBeenCalledTimes(
        scenario.startsWith("own-") && !restoredByInstaller ? 1 : 0,
      );
      if (restoredByInstaller) {
        expect(mocks.nativeRestart).toHaveBeenCalledOnce();
        expect(mocks.readiness).toHaveBeenCalledTimes(readinessBeforeRecovery + 1);
        expect(mocks.readiness.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
          mocks.nativeRestart.mock.invocationCallOrder[0]!,
        );
      }
      if (scenario === "own-pin-rebind") {
        expect(readDaemonRuntimePinForInstall(pinScope, serviceState.command, true).revision).toBe(
          original.definition.runtimePin?.revision,
        );
      }
      expect(await fs.readFile(state.env.OPENCLAW_CONFIG_PATH!)).toEqual(bytes);
    });
  });

  it.each(["slow", "not-ready"] as const)(
    "retained readiness uses current bounded owner: %s",
    async (scenario) => {
      const { before, mocks } = fixture();
      await admitted(async (run) => {
        const initial = mocks.health.getMockImplementation()!;
        mocks.health.mockImplementation(async (params) => {
          expect(params.timeoutMs).toBeGreaterThan(3_000);
          return initial(params);
        });
        if (scenario === "not-ready") {
          mocks.readiness.mockResolvedValue({ readyz: 503 });
        }
        const observation = observe(run, 40_000);
        if (scenario === "slow") {
          expect(await observation).toMatchObject({ verified: true });
        } else {
          await expect(observation).rejects.toThrow();
        }
        expectCalls(1, mocks.readiness, mocks.health);
        expect(mocks.readiness.mock.calls[0]?.[0].attempts).toBeGreaterThan(1);
        expect(mocks.readiness.mock.calls[0]?.[0].probeTimeoutMs).toBeGreaterThan(3_000);
        expect(before.stopped).toBe(false);
        expect(mocks.nativeRestart).not.toHaveBeenCalled();
      });
    },
  );

  it("refuses Windows split-root compensation before stopping the original", async () => {
    const { before, mocks } = fixture();
    await admitted(async (run) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        await expect(observe(run)).rejects.toMatchObject({ reason: "original-service-unverified" });
        expect(before.stopped).toBe(false);
        expectCalls(0, mocks.nativeRestart, mocks.nativeInstall, mocks.restart);
      } finally {
        platform.mockRestore();
      }
    });
  });

  it("waits for HTTP readiness after restoring the retained service", async () => {
    const { mocks } = fixture();
    await observed(async (original, run) => {
      expect(original.verified).toBe(true);
      const actual = await vi.importActual<typeof import("../daemon-cli/restart-health.js")>(
        "../daemon-cli/restart-health.js",
      );
      let readinessRequests = 0;
      const listener = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((request, response) => {
            const ready = request.url !== "/readyz" || ++readinessRequests > 1;
            response.writeHead(ready ? 200 : 503).end();
          }),
      });
      mocks.readiness.mockImplementation((params) =>
        actual.waitForGatewayHttpReadiness({ ...params, port: listener.claim.port }),
      );
      try {
        await expect(restartOriginal(original, run)).resolves.toBe("healthy");
        expect(mocks.nativeRestart).toHaveBeenCalledOnce();
        expect(readinessRequests).toBe(2);
      } finally {
        listener.listener.closeAllConnections();
        await listener.releaseListener();
        await listener.claim.release();
      }
    });
  });

  it.each(["launcher-limit", "launcher-drift"] as const)(
    "current F3 mandatory launcher identity: %s",
    async (scenario) => {
      const { rootA } = fixture();
      const createReader = integrity.createPackageIntegrityReader;
      vi.spyOn(integrity, "createPackageIntegrityReader").mockImplementation((timeout) => {
        const reader = createReader(timeout);
        return {
          ...reader,
          launcher: async (launcher) => {
            if (scenario === "launcher-limit") {
              throw new integrity.PackageIntegrityLimitError("byte");
            }
            return reader.launcher(launcher);
          },
        };
      });
      await admitted(async (run) => {
        const observation = observe(run);
        if (scenario === "launcher-limit") {
          await expect(observation).rejects.toMatchObject({
            reason: "original-service-unverified",
          });
          return;
        }
        const original = await observation;
        expect(original).toMatchObject({ root: rootA, version: "2026.9.3", verified: true });
        assert(original && run.executorFence, "missing admitted observation");
        await fs.appendFile(path.join(rootA, "dist/index.js"), "// replaced\n");
        await expect(
          revalidateOriginalManagedServiceRuntime(original, () =>
            run.executorFence!.assertCurrent(),
          ),
        ).rejects.toThrow("changed");
      });
    },
  );

  it.each([
    "healthy",
    "scheduled",
    "uncertain",
    "not-ready",
    "no-restart",
    "no-retained-custody",
    "manager-drift",
    "authority-lost",
  ] as const)("current F3 candidate-native selection: %s", async (scenario) => {
    const { state, rootB, before, serviceState, mocks } = fixture();
    const [probe, started] = [createDeferred(), createDeferred()];
    const actualLock = nativeLock.withGatewayServiceOperationLock;
    let locks = 0;
    vi.spyOn(nativeLock, "withGatewayServiceOperationLock").mockImplementation(
      async (env, operation) => {
        if (++locks === 2) {
          started.resolve();
          await probe.promise;
        }
        return actualLock(env, operation);
      },
    );
    const result = updateResult({
      status: "error",
      root: rootB,
      reason: "named-B-doctor-failure",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    });
    await observed(async (original, run) => {
      expect(original.verified).toBe(true);
      const config = await fs.readFile(state.env.OPENCLAW_CONFIG_PATH!);
      const packageB = await fs.readFile(path.join(rootB, "package.json"));
      if (scenario === "scheduled") {
        mocks.nativeRestart.mockResolvedValue({ outcome: "scheduled" });
      }
      if (scenario === "uncertain") {
        mocks.nativeRestart.mockRejectedValue(
          new UpdateCommandRecoveryPendingError("native cleanup unconfirmed"),
        );
      }
      if (scenario === "not-ready") {
        mocks.readiness.mockResolvedValue({ readyz: 503 });
      }
      const restore = vi.fn();
      const compensation = compensateOriginalManagedService(
        {
          ...recoveryParams(original, run),
          result,
          preManagedServiceStop: {
            ...before,
            stopped: true,
            windowsTaskAutoStartRecovery: {
              suspended: Promise.resolve(true),
              handoff() {},
              interrupted: () => false,
              beginMutation() {},
              assertRecoveryCurrent() {},
              restore,
              complete: vi.fn(),
            },
          },
          allowGatewayRestart: scenario !== "no-restart",
        },
        () => run.executorFence!.assertCurrent(),
      );
      // Attach before releasing the probe so an authority refusal cannot be unhandled.
      const outcome = compensation.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      if (scenario !== "no-restart" && scenario !== "no-retained-custody") {
        await Promise.race([started.promise, outcome]);
        expect(locks).toBe(2);
        expectCalls(0, mocks.capability, mocks.nativeRestart, mocks.restart);
        if (scenario === "manager-drift") {
          serviceState.env = {
            ...state.env,
            OPENCLAW_LAUNCHD_LABEL: "different-manager",
            OPENCLAW_SYSTEMD_UNIT: "different.service",
          };
        }
        if (scenario === "authority-lost") {
          run.executorFence = undefined;
        }
        probe.resolve();
      }
      const settled = await outcome;
      if (["scheduled", "uncertain", "authority-lost", "no-retained-custody"].includes(scenario)) {
        expect(settled.error).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      } else {
        expect(settled).toMatchObject({
          error: undefined,
          value: {
            rolledBack: false,
            originalServiceRecovery: scenario === "healthy" ? "healthy" : "failed",
            result: {
              status: result.status,
              root: rootB,
              reason: result.reason,
              recovery: { serviceRestartSafe: false },
            },
          },
        });
      }
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(restore).toHaveBeenCalledTimes(["healthy", "not-ready"].includes(scenario) ? 1 : 0);
      expect(mocks.nativeRestart).toHaveBeenCalledTimes(
        ["healthy", "scheduled", "uncertain", "not-ready"].includes(scenario) ? 1 : 0,
      );
      if (scenario === "healthy") {
        expect(mocks.capability).not.toHaveBeenCalled();
        expect(mocks.nativeRestart).toHaveBeenCalledWith(
          expect.objectContaining({
            env: original.service.serviceEnv,
            preserveDefinition: true,
            preserveAutoStart: true,
          }),
        );
        expect(mocks.health).toHaveBeenCalledWith(
          expect.objectContaining({ expectedVersion: "2026.9.3", expectedBuildId: "build-A" }),
        );
        expect(mocks.readiness).toHaveBeenCalledTimes(2);
      }
      expect(await fs.readFile(state.env.OPENCLAW_CONFIG_PATH!)).toEqual(config);
      expect(await fs.readFile(path.join(rootB, "package.json"))).toEqual(packageB);
    }, scenario !== "no-retained-custody");
  });
}
