import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
import type { GatewayServiceState } from "../../daemon/service.js";
import * as integrity from "../../infra/package-update-integrity.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  observeOriginalManagedServiceRuntime,
  revalidateOriginalManagedServiceRuntime,
} from "./update-command-original-service.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { restartRetainedUpdateGatewayService } from "./update-command-service-command.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-maintenance.js";
import {
  maybeRestartServiceAfterFailedMutableUpdate,
  compensateOriginalManagedService,
} from "./update-command-service-recovery.js";

type Fixture = {
  state: OpenClawTestState;
  rootA: string;
  rootB: string;
  before: PreManagedServiceStop;
  serviceState: GatewayServiceState;
  mocks: {
    capability: Mock;
    nativeRestart: Mock;
    nativeInstall: Mock;
    restart: Mock;
    health: Mock;
    readiness: Mock;
  };
};

// Current composition only: real observations, admission and candidate-native helper;
// receiver probe, native service and HTTP leaves are inert. No native command executes.
export function registerCurrentF3Controls(fixture: () => Fixture) {
  const admitted = async (
    operation: (run: NonNullable<UpdateCommandOptions["run"]>) => Promise<void>,
    retained = true,
  ) => {
    const { state, rootA, rootB } = fixture();
    const run: NonNullable<UpdateCommandOptions["run"]> = {
      runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
      env: state.env,
    };
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(rootB, retained ? { serviceRoot: rootA } : {});
      await operation(run);
    });
  };

  it.each(["unchanged", "replaced"] as const)(
    "capable original recovery binds definition after native lock: %s",
    async (scenario) => {
      const { state, rootB, before, serviceState, mocks } = fixture();
      await admitted(async (run) => {
        const original = await observeOriginalManagedServiceRuntime(
          { root: rootB, opts: { run } },
          before,
        );
        if (!original) {
          throw new Error("missing original observation");
        }
        mocks.capability.mockResolvedValue(true);
        const lock = nativeLock.withGatewayServiceOperationLock;
        const held = createDeferred();
        const waiting = createDeferred();
        const release = createDeferred();
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
              // A separate cooperative operation acquires after restoration's lock,
              // before the recovery caller can acquire its restart lock.
              holder = lock(env, async () => {
                held.resolve();
                await release.promise;
              });
              await held.promise;
            }
            return result;
          },
        );
        // Model the shipped capable receiver: it has executor custody and a native
        // lock, but its restart transport accepts no original-definition binding.
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
        const work = maybeRestartServiceAfterFailedMutableUpdate({
          updateRun: run,
          preManagedServiceStop: { ...before, stopped: true },
          originalManagedServiceRuntime: original,
          jsonMode: true,
          timeoutMs: 30_000,
        });
        const settled = work.then(
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
        expect(mocks.restart).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["current", "replaced", "revoked"] as const)(
    "revalidates retained definition after final native lock: %s",
    async (scenario) => {
      const { state, rootA, rootB, before, serviceState, mocks } = fixture();
      await admitted(async (run) => {
        const original = await observeOriginalManagedServiceRuntime(
          { root: rootB, opts: { run } },
          before,
        );
        if (!original) {
          throw new Error("missing original observation");
        }
        const entered = createDeferred();
        const release = createDeferred();
        const holder = withGatewayServiceOperationLock(state.env, async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        const revalidate = vi.fn(async () => {
          await revalidateOriginalManagedServiceRuntime(original, () =>
            run.executorFence!.assertCurrent(),
          );
        });
        const work = restartRetainedUpdateGatewayService({
          run,
          root: rootA,
          env: state.env,
          stdout: process.stdout,
          assertCurrent: () => run.executorFence!.assertCurrent(),
          revalidate,
        });
        const result = work.then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        try {
          expect(revalidate).not.toHaveBeenCalled();
          expect(mocks.nativeRestart).not.toHaveBeenCalled();
          if (scenario === "replaced") {
            serviceState.command!.programArguments.push("--replacement");
          }
          if (scenario === "revoked") {
            run.executorFence = undefined;
          }
        } finally {
          release.resolve();
          await holder;
        }
        const settled = await result;
        expect(Boolean(settled.error)).toBe(scenario !== "current");
        expect(mocks.nativeRestart).toHaveBeenCalledTimes(scenario === "current" ? 1 : 0);
        if (scenario === "current") {
          expect(revalidate).toHaveBeenCalledOnce();
        }
      });
    },
  );

  it.each([
    "own-rebind",
    "own-rebind-without-stop",
    "own-compensated-rebind-without-stop",
    "own-pin-rebind",
    "foreign-pin",
    "unrelated-replacement",
    "revoked",
    "schema-newer",
  ] as const)("retained own-rebind compensation: %s", async (scenario) => {
    const { state, rootA, rootB, before, serviceState, mocks } = fixture();
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
    const pinScenario = scenario === "own-pin-rebind" || scenario === "foreign-pin";
    if (pinScenario) {
      commitDaemonRuntimePin(
        pinScope,
        {
          expected: readDaemonRuntimePinForInstall(pinScope, serviceState.command, true),
          pin: { runtime: "node", path: process.execPath },
        },
        serviceState.command,
      );
    }
    await admitted(async (run) => {
      const original = await observeOriginalManagedServiceRuntime(
        { root: rootB, opts: { run } },
        before,
      );
      if (!original) {
        throw new Error("missing original observation");
      }
      const originalCommand = structuredClone(serviceState.command!);
      const originalDigest = await fingerprintGatewayServiceDefinition(originalCommand);
      let receipt: ReturnType<typeof currentGatewayServiceRebindReceipt>;
      await withGatewayServiceOperationLock(state.env, async (assertCurrent) =>
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
                      process.execPath,
                      path.join(rootB, "dist/index.js"),
                      "gateway",
                    ],
                  };
                  serviceState.command.managedDefinition = {
                    ...managedDefinition,
                    programArguments: serviceState.command.programArguments,
                  };
                  if (pinScenario) {
                    commitDaemonRuntimePin(
                      pinScope,
                      {
                        expected: original.definition.runtimePin,
                        pin: { runtime: "node", path: "/selected-B-node" },
                      },
                      serviceState.command,
                    );
                  }
                },
                () => readDaemonRuntimePinForInstall(pinScope, null, true).revision,
              );
              if (scenario === "own-compensated-rebind-without-stop") {
                // Main's definition compensation restores A, but does not restart it.
                serviceState.command = structuredClone(originalCommand);
              }
            });
            receipt = currentGatewayServiceRebindReceipt();
          },
          original.definition.runtimePin.revision,
        ),
      );
      // Receipt is emitted by the actual native rewrite owner, never a synthesized success.
      if (!receipt) {
        throw new Error("missing native receipt");
      }
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
        expect(args.programArguments).toEqual(originalCommand.programArguments);
        expect(args.workingDirectory).toBe(managedDefinition.workingDirectory);
        expect(args.preserveAutoStart).toBe(true);
        serviceState.command = structuredClone(originalCommand);
        commitDaemonRuntimePin(pinScope, args.runtimePinUpdate, serviceState.command);
      });
      if (scenario === "foreign-pin") {
        commitDaemonRuntimePin(
          pinScope,
          {
            expected: readDaemonRuntimePinForInstall(pinScope, serviceState.command, true),
            pin: { runtime: "node", path: "/operator-node" },
          },
          serviceState.command,
        );
      }
      if (scenario === "unrelated-replacement") {
        if (!serviceState.command) {
          throw new Error("missing rebound command");
        }
        serviceState.command.programArguments.push("--foreign");
      }
      if (scenario === "revoked") {
        run.executorFence = undefined;
      }
      if (scenario === "schema-newer") {
        original.schemaVersions = { state: 0, agent: 0 };
      }
      const result: UpdateRunResult = {
        status: "error",
        mode: "npm",
        root: rootB,
        reason: "B-health-failed",
        steps: [],
        durationMs: 1,
      };
      const bytes = await fs.readFile(state.env.OPENCLAW_CONFIG_PATH!);
      const readinessBeforeRecovery = mocks.readiness.mock.calls.length;
      const outcome = compensateOriginalManagedService(
        {
          result,
          opts: { run, json: true },
          originalManagedServiceRuntime: original,
          preManagedServiceStop: { ...before, stopped: !scenario.endsWith("without-stop") },
          allowGatewayRestart: true,
          timeoutMs: 30_000,
        },
        () => run.executorFence!.assertCurrent(),
      );
      if (scenario === "revoked") {
        await expect(outcome).rejects.toThrow();
      } else {
        const recovery = await outcome;
        expect(recovery).toMatchObject({
          rolledBack: false,
          originalServiceRecovery: scenario.startsWith("own-") ? "healthy" : "failed",
        });
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
          original.definition.runtimePin.revision,
        );
      }
      expect(await fs.readFile(state.env.OPENCLAW_CONFIG_PATH!)).toEqual(bytes);
    });
  });

  it.each(["slow", "revoked", "generation-change"] as const)(
    "retained readiness uses current bounded owner: %s",
    async (scenario) => {
      const { rootB, before, mocks } = fixture();
      await admitted(async (run) => {
        const initial = mocks.health.getMockImplementation()!;
        mocks.health.mockImplementation(async (params) => {
          expect(params.timeoutMs).toBeGreaterThan(3_000);
          const result = await initial(params);
          if (scenario === "revoked") {
            run.executorFence = undefined;
          }
          return {
            ...result,
            gatewayBootId: scenario === "generation-change" ? "prior-boot" : undefined,
          };
        });
        const observation = observeOriginalManagedServiceRuntime(
          { root: rootB, opts: { run }, updateStepTimeoutMs: 40_000 },
          before,
        );
        if (scenario === "slow") {
          expect(await observation).toMatchObject({ verified: true });
          expect(mocks.readiness).toHaveBeenCalledWith(
            expect.objectContaining({
              attempts: expect.any(Number),
              probeTimeoutMs: expect.any(Number),
            }),
          );
          expect(mocks.readiness.mock.calls[0]?.[0].probeTimeoutMs).toBeGreaterThan(3_000);
        } else {
          await expect(observation).rejects.toThrow();
        }
        expect(mocks.health).toHaveBeenCalledOnce();
      });
    },
  );

  it("refuses Windows split-root compensation before stopping the original", async () => {
    const { rootB, before, mocks } = fixture();
    await admitted(async (run) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        await expect(
          observeOriginalManagedServiceRuntime({ root: rootB, opts: { run } }, before),
        ).rejects.toMatchObject({ reason: "original-service-unverified" });
        expect(before.stopped).toBe(false);
        expect(mocks.nativeRestart).not.toHaveBeenCalled();
        expect(mocks.nativeInstall).not.toHaveBeenCalled();
        expect(mocks.restart).not.toHaveBeenCalled();
      } finally {
        platform.mockRestore();
      }
    });
  });

  it("refuses a completed later fingerprint mismatch instead of downgrading it to a warning", async () => {
    const { rootB, before } = fixture();
    await admitted(async (run) => {
      const original = await observeOriginalManagedServiceRuntime(
        { root: rootB, opts: { run } },
        before,
      );
      if (!original?.packageFingerprint) {
        throw new Error("missing complete baseline");
      }
      const reader = integrity.createPackageIntegrityReader;
      vi.spyOn(integrity, "createPackageIntegrityReader").mockImplementation((timeout) => ({
        ...reader(timeout),
        tree: async () => ({ ...original.packageFingerprint!, digest: "different" }),
      }));
      await expect(
        revalidateOriginalManagedServiceRuntime(original, () => run.executorFence!.assertCurrent()),
      ).rejects.toThrow("package changed");
      expect(original.packageFingerprintWarning).toBeUndefined();
    });
  });

  it.each([
    "timeout",
    "entry-limit",
    "byte-limit",
    "read-error",
    "later-timeout",
    "later-entry-limit",
    "later-byte-limit",
    "launcher-limit",
    "launcher-drift",
    "read-window",
  ] as const)("current F3 mandatory identity and optional tree: %s", async (scenario) => {
    const { rootA, rootB, before } = fixture();
    const createReader = integrity.createPackageIntegrityReader;
    let treeReads = 0;
    let displaced = false;
    vi.spyOn(integrity, "createPackageIntegrityReader").mockImplementation((timeout) => {
      const reader = createReader(timeout);
      return {
        ...reader,
        tree: async (root, originalRoot) => {
          treeReads++;
          if (scenario === "read-error") {
            throw new Error("mandatory package access failed");
          }
          if (!scenario.startsWith("later-") || treeReads > 1) {
            if (scenario.includes("entry-limit")) {
              throw new integrity.PackageIntegrityLimitError("entry");
            }
            if (scenario.includes("byte-limit")) {
              throw new integrity.PackageIntegrityLimitError("byte");
            }
            throw new integrity.PackageIntegrityTimeoutError(30_000);
          }
          return reader.tree(root, originalRoot);
        },
        launcher: async (launcher) => {
          if (scenario === "launcher-limit") {
            throw new integrity.PackageIntegrityLimitError("byte");
          }
          const value = await reader.launcher(launcher);
          if (scenario === "read-window" && !displaced) {
            displaced = true;
            await fs.rename(rootA, `${rootA}-displaced`);
            await fs.cp(`${rootA}-displaced`, rootA, { recursive: true });
          }
          return value;
        },
      };
    });
    await admitted(async (run) => {
      const observation = observeOriginalManagedServiceRuntime(
        { root: rootB, opts: { run } },
        before,
      );
      if (["read-error", "read-window", "launcher-limit"].includes(scenario)) {
        await expect(observation).rejects.toMatchObject({
          reason: "original-service-unverified",
        });
        return;
      }
      const original = await observation;
      expect(original).toMatchObject({ root: rootA, version: "2026.9.3", verified: true });
      if (scenario.startsWith("later-")) {
        expect(original).toHaveProperty("packageFingerprint");
      } else {
        expect(original).not.toHaveProperty("packageFingerprint");
      }
      expect(original).toHaveProperty(
        "packageFingerprintWarning",
        expect.stringContaining("full package contents are unverified"),
      );
      expect(treeReads).toBe(scenario.startsWith("later-") ? 2 : 1);
      if (!original || !run.executorFence) {
        throw new Error("missing admitted observation");
      }
      if (scenario === "launcher-drift") {
        await fs.appendFile(path.join(rootA, "dist/index.js"), "// replaced\n");
        await expect(
          revalidateOriginalManagedServiceRuntime(original, () =>
            run.executorFence!.assertCurrent(),
          ),
        ).rejects.toThrow("changed");
      } else {
        await revalidateOriginalManagedServiceRuntime(original, () =>
          run.executorFence!.assertCurrent(),
        );
        expect(treeReads).toBe(scenario.startsWith("later-") ? 3 : 1);
      }
    });
  });

  it.each([
    "unsupported",
    "capable",
    "scheduled",
    "uncertain",
    "not-ready",
    "no-restart",
    "no-retained-custody",
    "definition-drift",
    "manager-drift",
    "authority-lost",
  ] as const)("current F3 candidate-native selection: %s", async (scenario) => {
    const { state, rootB, before, serviceState, mocks } = fixture();
    const probe = createDeferred();
    const started = createDeferred();
    mocks.capability.mockResolvedValue(scenario === "capable");
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
    const result: UpdateRunResult = {
      status: "error" as const,
      mode: "npm" as const,
      root: rootB,
      reason: "named-B-doctor-failure",
      steps: [],
      durationMs: 1,
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" as const },
    };
    await admitted(async (run) => {
      const original = await observeOriginalManagedServiceRuntime(
        { root: rootB, opts: { run } },
        before,
      );
      expect(original?.verified).toBe(true);
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
          result,
          opts: { json: true, run },
          preManagedServiceStop: {
            ...before,
            stopped: true,
            windowsTaskAutoStartRecovery: {
              suspended: Promise.resolve(true),
              handoff() {},
              interrupted: () => false,
              beginMutation() {},
              restore,
              complete: vi.fn(),
            },
          },
          originalManagedServiceRuntime: original,
          allowGatewayRestart: scenario !== "no-restart",
          timeoutMs: 30_000,
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
        expect(mocks.capability).not.toHaveBeenCalled();
        expect(mocks.nativeRestart).not.toHaveBeenCalled();
        expect(mocks.restart).not.toHaveBeenCalled();
        if (scenario === "definition-drift") {
          serviceState.command!.programArguments.push("--port", "19997");
        }
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
        const healthy = scenario === "unsupported" || scenario === "capable";
        expect(settled.error).toBeUndefined();
        expect(settled.value).toMatchObject({
          rolledBack: false,
          originalServiceRecovery: healthy ? "healthy" : "failed",
          result: {
            status: result.status,
            root: rootB,
            reason: result.reason,
            recovery: { serviceRestartSafe: false },
          },
        });
      }
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(restore).toHaveBeenCalledTimes(
        ["unsupported", "capable", "not-ready"].includes(scenario) ? 1 : 0,
      );
      expect(mocks.nativeRestart).toHaveBeenCalledTimes(
        ["unsupported", "capable", "scheduled", "uncertain", "not-ready"].includes(scenario)
          ? 1
          : 0,
      );
      if (scenario === "unsupported") {
        expect(mocks.capability).not.toHaveBeenCalled();
        expect(mocks.nativeRestart).toHaveBeenCalledWith(
          expect.objectContaining({
            env: original?.service.serviceEnv,
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
