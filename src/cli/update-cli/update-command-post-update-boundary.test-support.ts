import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayServiceStopUnsafeError } from "../../daemon/service-inspection-error.js";
import { GatewayServiceAuthorityError } from "../../daemon/service-update-authority.js";
import * as gatewayOwner from "../../infra/gateway-owner-lease.js";
import type { PackageLauncherFingerprint } from "../../infra/package-update-integrity.js";
import { stopSupervisedPredecessorGateway } from "../../infra/update-candidate-predecessor-stop.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as updateWriter from "../../infra/update-run-write.async.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import * as postUpdateMaintenance from "./update-command-post-update-maintenance.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  managedServiceState,
} from "./update-command-post-update.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import * as rollbackModule from "./update-command-rollback.js";
import * as nativeCommand from "./update-command-service-command.js";
import type {
  OriginalManagedServiceRuntime,
  PreManagedServiceStop,
} from "./update-command-service-context-types.js";
import * as serviceMaintenance from "./update-command-service-maintenance.js";
import * as serviceOperations from "./update-command-service.js";

export function registerBoundaryFinalizationControls({
  makeTempDir,
  mocks,
}: {
  makeTempDir: (prefix: string) => string;
  mocks: {
    readServiceState: Mock;
    restartService: Mock<typeof import("./update-command-service.js").maybeRestartService>;
  };
}) {
  it.each(["confirmed", "unknown", "refused", "revoked", "replaced"] as const)(
    "settles progress before finalization and retains its failure (%s)",
    async (outcome) => {
      const entered = createDeferred();
      const release = createDeferred();
      const receiptFailure =
        outcome === "unknown"
          ? new CommandProcessCleanupError({ cause: new Error("receipt reply lost") })
          : new Error("progress receipt refused");
      const env = { OPENCLAW_STATE_DIR: makeTempDir("finalizer-progress-") };
      const record = createUpdateRun({ trigger: "cli" }, { env });
      let current = true;
      const run = {
        runId: record.runId,
        env,
        executorFence: { assertCurrent() {} },
        ...(outcome === "revoked"
          ? { requesterAuthority: { requester: {}, isCurrent: () => current } }
          : {}),
      };
      const rollback = vi.spyOn(rollbackModule, "rollbackFailedUpdate");
      const prepareService = vi.spyOn(postUpdateMaintenance, "preparePostUpdateService");
      const finishing = finishSuccessfulPackageSwitch(
        outcome === "revoked" || outcome === "replaced" ? { run } : {},
        {},
        {
          beforeFinalization: async () => {
            entered.resolve();
            await release.promise;
            if (outcome !== "confirmed") {
              throw receiptFailure;
            }
          },
        },
      );
      try {
        await Promise.race([
          entered.promise,
          finishing.then(() => {
            throw new Error("Finalization completed before progress settlement entered.");
          }),
        ]);
        expect(mocks.readServiceState).not.toHaveBeenCalled();
        expect(prepareService).not.toHaveBeenCalled();
        expect(mocks.restartService).not.toHaveBeenCalled();
        expect(rollback).not.toHaveBeenCalled();
        current = outcome !== "revoked";
        if (outcome === "replaced") {
          run.executorFence = { assertCurrent() {} };
        }
        release.resolve();
        if (outcome === "confirmed") {
          await finishing;
          expect(prepareService).toHaveBeenCalledOnce();
          expect(mocks.restartService).toHaveBeenCalledOnce();
        } else if (outcome === "unknown") {
          await expect(finishing).rejects.toBe(receiptFailure);
        } else if (outcome === "refused") {
          await expect(finishing).rejects.toMatchObject({
            result: {
              status: "error",
              steps: expect.arrayContaining([
                expect.objectContaining({ stderrTail: receiptFailure.message }),
              ]),
            },
            cause: receiptFailure,
          });
        } else {
          await expect(finishing).rejects.toMatchObject({
            errors: [
              outcome === "revoked"
                ? expect.objectContaining({ message: "requester-revoked" })
                : expect.objectContaining({
                    cause: expect.objectContaining({
                      message: "Package finalization lost its original executor.",
                    }),
                  }),
              receiptFailure,
            ],
          });
          expect(getUpdateRun(record.runId, { env })?.status).toBe("running");
        }
        if (outcome !== "confirmed") {
          expect(prepareService).not.toHaveBeenCalled();
          expect(mocks.readServiceState).not.toHaveBeenCalled();
          expect(mocks.restartService).not.toHaveBeenCalled();
          expect(rollback).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await finishing.catch(() => undefined);
      }
    },
  );

  it
    .runIf(process.platform !== "win32")
    .each([
      "stopped",
      "not-stopped",
      "joined-error",
      "cleanup-uncertain",
      "native-unsafe",
      "receipt-write-failed",
      "receipt-pending",
      "receipt-pending-native-error",
      "receipt-and-stop-failed",
      "run-finished",
    ] as const)("settles the POSIX predecessor stop before Doctor: %s", async (scenario) => {
    const home = makeTempDir("predecessor-stop-receipt-");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
    const env = { ...process.env };
    const run = createUpdateRun({ trigger: "cli" }, { env });
    vi.spyOn(gatewayOwner, "readGatewayOwnerLease").mockReturnValue({
      owner: "fixture-gateway",
      pid: 631,
      host: "fixture-host",
      startedAt: 1,
      state: "live",
      expired: false,
      mode: "supervised",
      port: 18789,
      supervisor: { kind: "systemd", name: "fixture-gateway" },
    });
    const stopped: PreManagedServiceStop = {
      stopped: true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      stoppedAtMs: 7,
      servicePid: 631,
      serviceManagerUid: 1000,
      serviceUpdateVerdict: {
        kind: "owned",
        root: home,
        fingerprint: "sealed",
        refreshDefinition: false,
      },
    };
    const failure =
      scenario === "cleanup-uncertain"
        ? new AggregateError([new CommandProcessCleanupError()], "native cleanup failed")
        : scenario === "native-unsafe"
          ? new GatewayServiceStopUnsafeError("native stop custody is uncertain")
          : new Error("stop receipt or joined verification failed");
    const receiptFailure = new Error("receipt persistence failed independently");
    const receiptEntered = createDeferred();
    const releaseReceipt = createDeferred();
    const write = updateWriter.recordUpdateRunStepAsync;
    const writer = vi
      .spyOn(updateWriter, "recordUpdateRunStepAsync")
      .mockImplementation(async (...args) => {
        if (scenario.startsWith("receipt-pending")) {
          receiptEntered.resolve();
          await releaseReceipt.promise;
        }
        if (scenario === "receipt-write-failed") {
          throw failure;
        }
        if (scenario === "receipt-and-stop-failed") {
          throw receiptFailure;
        }
        return write(...args);
      });
    vi.spyOn(serviceMaintenance, "maybeStopManagedServiceBeforeMutableUpdate").mockImplementation(
      async (params) => {
        params.assertCurrent?.();
        if (scenario === "not-stopped") {
          return { ...stopped, stopped: false };
        }
        if (scenario === "run-finished") {
          updateLedger.finishUpdateRun(run.runId, { status: "failed" }, { env });
        }
        if (scenario === "native-unsafe") {
          throw failure;
        }
        params.onStopped?.(stopped);
        if (
          [
            "joined-error",
            "cleanup-uncertain",
            "receipt-pending-native-error",
            "receipt-and-stop-failed",
          ].includes(scenario)
        ) {
          throw failure;
        }
        return stopped;
      },
    );
    const warn = vi.fn();
    const hostSql = scenario === "stopped" ? observeMainThreadSql() : undefined;
    hostSql?.calibrate();
    const stopping = stopSupervisedPredecessorGateway(
      { runId: run.runId, repair: true },
      { root: home, assertCurrent: vi.fn(), warn },
    );
    let settled = false;
    void stopping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    if (scenario.startsWith("receipt-pending")) {
      try {
        await receiptEntered.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        expect(getUpdateRun(run.runId, { env })?.steps).toEqual(run.steps);
      } finally {
        releaseReceipt.resolve();
        await stopping.catch(() => undefined);
      }
    }
    if (["cleanup-uncertain", "native-unsafe", "receipt-write-failed"].includes(scenario)) {
      await expect(stopping).rejects.toBe(failure);
    } else if (scenario === "receipt-and-stop-failed") {
      await expect(stopping).rejects.toMatchObject({
        errors: [failure, receiptFailure],
        cause: failure,
      });
    } else if (scenario === "run-finished") {
      await expect(stopping).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
    } else {
      await expect(stopping).resolves.toBe(scenario !== "not-stopped");
    }
    expect(writer).toHaveBeenCalledTimes(
      ["not-stopped", "native-unsafe"].includes(scenario) ? 0 : 1,
    );
    expect(warn).toHaveBeenCalledTimes(
      ["joined-error", "receipt-pending-native-error"].includes(scenario) ? 1 : 0,
    );
    try {
      hostSql?.expectIdle();
    } finally {
      hostSql?.restore();
    }
    const receipts = getUpdateRun(run.runId, { env })?.steps.filter((step) =>
      step.step.startsWith("finalize:predecessor-stop:"),
    );
    expect(receipts).toEqual(
      [
        "receipt-write-failed",
        "receipt-and-stop-failed",
        "run-finished",
        "not-stopped",
        "native-unsafe",
      ].includes(scenario)
        ? []
        : [
            expect.objectContaining({
              step: "finalize:predecessor-stop:7:1000:631:sealed",
              status: "completed",
            }),
          ],
    );
  });

  it.runIf(process.platform !== "win32").each([
    { route: "ordinary", scenario: "stopped" },
    { route: "ordinary", scenario: "owned-selectors" },
    { route: "ordinary", scenario: "failed-uninspected" },
    { route: "ordinary", scenario: "legacy-stop-failed" },
    { route: "ordinary", scenario: "legacy-stop-uncertain" },
    { route: "ordinary", scenario: "legacy-stop-revoked" },
    { route: "ordinary", scenario: "legacy-stop-native-authority" },
    { route: "ordinary", scenario: "inspection-unavailable" },
    { route: "ordinary", scenario: "inspection-threw" },
    { route: "ordinary", scenario: "inspection-uncertain" },
    { route: "ordinary", scenario: "inspection-native-authority" },
    { route: "ordinary", scenario: "runtime-unverified" },
    { route: "migrated", scenario: "stopped" },
    { route: "migrated", scenario: "restart-requested" },
    { route: "migrated", scenario: "legacy-stopped" },
    { route: "migrated", scenario: "legacy-no-stop" },
    { route: "ordinary", scenario: "no-receipt" },
    { route: "ordinary", scenario: "replaced-service" },
    { route: "ordinary", scenario: "replaced-manager" },
    { route: "ordinary", scenario: "already-running" },
    { route: "ordinary", scenario: "executor-revoked" },
    { route: "ordinary", scenario: "requester-revoked" },
  ] as const)(
    "adopts a POSIX Doctor stop during $route finalization ($scenario)",
    async ({ route, scenario }) => {
      const home = makeTempDir("finalizer-doctor-stop-");
      const identity = createManagedServiceIdentityFixture(home);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
      const env = { ...process.env };
      const record = createUpdateRun({ trigger: "cli" }, { env });
      let currentExecutor = true;
      let currentRequester = true;
      let running = true;
      const fence = {
        assertCurrent: () => {
          if (!currentExecutor) {
            throw new Error("fixture executor revoked");
          }
        },
      };
      const stopFailure = scenario.endsWith("uncertain")
        ? new CommandProcessCleanupError()
        : scenario.endsWith("native-authority")
          ? new GatewayServiceAuthorityError(new Error("native authority revoked"))
          : new Error("native verification failed after stop");
      const originalService = {
        stopped: false,
        inspected: true,
        runtimeInspected: true,
        running: true,
        servicePid: 631,
        serviceManagerUid: 1000,
        serviceEnv: env,
        serviceUpdateVerdict: {
          kind: "owned" as const,
          root: "/tmp/openclaw-update",
          fingerprint: "sealed",
          refreshDefinition: false,
        },
      };
      const legacy =
        scenario === "legacy-stopped" ||
        scenario === "legacy-no-stop" ||
        scenario.startsWith("legacy-stop-") ||
        scenario === "failed-uninspected";
      const transferred: PreManagedServiceStop = legacy
        ? {
            stopped: false,
            inspected: false,
            runtimeInspected: false,
            running: false,
            serviceMutationAllowed: false,
            serviceUpdateVerdict: { kind: "unavailable", message: "legacy inspection unavailable" },
          }
        : originalService;
      vi.spyOn(gatewayOwner, "readGatewayOwnerLease").mockReturnValue({
        owner: "fixture-gateway",
        pid: 631,
        host: "fixture-host",
        startedAt: 1,
        state: "live",
        expired: false,
        mode: "supervised",
        port: 18789,
        supervisor: { kind: "systemd", name: "fixture-gateway" },
      });
      const inspect = vi
        .spyOn(serviceMaintenance, "maybeStopManagedServiceBeforeMutableUpdate")
        .mockImplementation(async (params) => {
          params.assertCurrent?.();
          if (scenario === "owned-selectors") {
            expect(process.env.OPENCLAW_STATE_DIR).toBe(env.OPENCLAW_STATE_DIR);
          }
          if (params.phase === "prepare") {
            running = scenario === "legacy-no-stop";
            const stopped = { ...originalService, stopped: !running, stoppedAtMs: 7 };
            if (stopped.stopped) {
              params.onStopped?.(stopped);
            }
            if (scenario.startsWith("legacy-stop-")) {
              currentExecutor = scenario !== "legacy-stop-revoked";
              throw stopFailure;
            }
            return stopped;
          }
          currentExecutor = scenario !== "executor-revoked";
          currentRequester = scenario !== "requester-revoked";
          if (
            scenario === "inspection-threw" ||
            scenario === "inspection-uncertain" ||
            scenario === "inspection-native-authority"
          ) {
            throw stopFailure;
          }
          return {
            ...originalService,
            inspected: scenario !== "inspection-unavailable",
            runtimeInspected: scenario !== "runtime-unverified",
            running,
            serviceManagerUid: scenario === "replaced-manager" ? 1001 : 1000,
            serviceUpdateVerdict: {
              ...originalService.serviceUpdateVerdict,
              fingerprint: scenario === "replaced-service" ? "replacement" : "sealed",
            },
          };
        });
      mocks.readServiceState.mockResolvedValue(managedServiceState(env));
      const recover = vi
        .spyOn(serviceOperations, "maybeRestartServiceAfterFailedMutableUpdate")
        .mockImplementation(async ({ preManagedServiceStop }) => {
          expect(preManagedServiceStop?.stopped).toBe(true);
          running = true;
          return "healthy";
        });
      mocks.restartService.mockImplementation(
        async ({ shouldRestart, requireRunningServiceAfterRestart }) => {
          if (shouldRestart) {
            expect(requireRunningServiceAfterRestart).toBe(scenario !== "legacy-no-stop");
            running = true;
          }
          return "ok";
        },
      );
      try {
        if (scenario !== "no-receipt" && !legacy) {
          await stopSupervisedPredecessorGateway(
            { runId: record.runId, repair: true },
            {
              root: originalService.serviceUpdateVerdict.root,
              assertCurrent: fence.assertCurrent,
              warn: vi.fn(),
            },
          );
          expect(getUpdateRun(record.runId, { env })?.steps).toContainEqual(
            expect.objectContaining({ step: "finalize:predecessor-stop:7:1000:631:sealed" }),
          );
        }
        if (scenario === "already-running") {
          running = true;
        }
        if (scenario === "owned-selectors") {
          vi.stubEnv("OPENCLAW_PROFILE", "other");
          vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw-other"));
        }
        inspect.mockClear();
        const finishing = finishSuccessfulPackageSwitch(
          {
            restartEnvironment: env,
            run: {
              runId: record.runId,
              env,
              executorFence: fence,
              requesterAuthority: { requester: {}, isCurrent: () => currentRequester },
            },
          },
          {
            shouldRestart: scenario === "restart-requested" || legacy,
            preManagedServiceStop: transferred,
            ...(scenario === "failed-uninspected"
              ? {
                  result: {
                    status: "error" as const,
                    reason: "package-install",
                    mode: "npm" as const,
                    root: originalService.serviceUpdateVerdict.root,
                    steps: [],
                    durationMs: 0,
                    recovery: {
                      serviceRestartSafe: false as const,
                      reason: "runtime-verification-failed" as const,
                    },
                  },
                }
              : {}),
            ...(scenario.startsWith("legacy-stop-")
              ? {
                  result: {
                    status: "ok" as const,
                    mode: "npm" as const,
                    root: originalService.serviceUpdateVerdict.root,
                    steps: [],
                    durationMs: 0,
                    recovery: { serviceRestartSafe: true as const, version: "2.0.0" },
                  },
                }
              : {}),
          },
          { candidateRuntime: route === "migrated" },
        );
        if (scenario === "legacy-stop-failed") {
          const failure = await finishing.then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(running).toBe(true);
          expect(recover).toHaveBeenCalledOnce();
          expect(failure).toMatchObject({ name: "UpdateCommandFailure", cause: stopFailure });
        } else if (
          scenario === "legacy-stop-uncertain" ||
          scenario === "legacy-stop-revoked" ||
          scenario === "legacy-stop-native-authority" ||
          scenario === "inspection-uncertain" ||
          scenario === "inspection-native-authority"
        ) {
          const failure = await finishing.then(
            () => undefined,
            (error: unknown) => error,
          );
          if (scenario === "legacy-stop-revoked") {
            expect(failure).toMatchObject({ errors: expect.arrayContaining([stopFailure]) });
          } else {
            expect(failure).toBe(stopFailure);
          }
          expect(recover).not.toHaveBeenCalled();
          expect(mocks.restartService).not.toHaveBeenCalled();
          expect(running).toBe(false);
        } else if (
          scenario === "inspection-unavailable" ||
          scenario === "runtime-unverified" ||
          scenario === "inspection-threw"
        ) {
          await expect(finishing).rejects.toMatchObject({
            name: "UpdateCommandPendingRecoveryFailure",
            result: { status: "error", recovery: { serviceRestartSafe: false } },
            ...(scenario === "inspection-threw" ? { cause: { cause: stopFailure } } : {}),
          });
          expect(recover).not.toHaveBeenCalled();
          expect(mocks.restartService).not.toHaveBeenCalled();
          expect(running).toBe(false);
        } else if (scenario === "failed-uninspected") {
          await expect(finishing).rejects.toMatchObject({ name: "UpdateCommandFailure" });
          expect(running).toBe(true);
          expect(mocks.restartService).not.toHaveBeenCalled();
        } else if (scenario === "executor-revoked" || scenario === "requester-revoked") {
          await expect(finishing).rejects.toThrow(/revoked/);
          expect(mocks.restartService).not.toHaveBeenCalled();
          expect(getUpdateRun(record.runId, { env })?.status).toBe("running");
        } else {
          await finishing;
          expect(running).toBe(!["replaced-service", "replaced-manager"].includes(scenario));
          expect(mocks.restartService.mock.calls.map(([params]) => params.shouldRestart)).toEqual([
            scenario === "stopped" ||
              scenario === "owned-selectors" ||
              scenario === "restart-requested" ||
              legacy,
          ]);
          if (scenario === "owned-selectors") {
            expect(process.env.OPENCLAW_PROFILE).toBe("other");
            expect(process.env.OPENCLAW_STATE_DIR).toBe(path.join(home, ".openclaw-other"));
          }
        }
        expect(inspect.mock.calls.map(([params]) => params.phase)).toEqual(
          scenario === "no-receipt" || scenario === "failed-uninspected"
            ? []
            : [legacy ? "prepare" : "inspect"],
        );
      } finally {
        identity.restore();
      }
    },
  );

  it.each(["missing-entrypoint", "unsettled-child"] as const)(
    "retained service finalization distinguishes native effects: %s",
    async (scenario) => {
      const home = makeTempDir("retained-boundary-no-effect-");
      const identity = createManagedServiceIdentityFixture(home);
      try {
        await fs.mkdir(path.join(home, "dist"));
        await fs.writeFile(
          path.join(home, "package.json"),
          JSON.stringify({ name: "openclaw", type: "module" }),
        );
        const launcherFingerprint: PackageLauncherFingerprint = {
          type: "file",
          mode: "33188",
          uid: "0",
          gid: "0",
          contents: "fixture",
        };
        const original: OriginalManagedServiceRuntime = {
          root: home,
          nodeRunner: process.execPath,
          version: "2026.9.3",
          verified: true,
          definition: {
            command: { programArguments: [process.execPath, path.join(home, "dist/index.js")] },
            fingerprint: "fixture-original",
            runtimePin: { revision: "fixture-no-runtime-pin", stored: false },
          },
          service: { serviceEnv: { HOME: home } },
          packageIdentity: { identity: "fixture-directory", version: "2026.9.3" },
          launcher: {
            path: "fixture",
            realPath: "fixture",
            fingerprint: launcherFingerprint,
            targetFingerprint: launcherFingerprint,
          },
          nodeIdentity: "fixture-node",
        };
        mocks.readServiceState.mockResolvedValue(managedServiceState(process.env));
        const actual = await vi.importActual<typeof import("./update-command-service.js")>(
          "./update-command-service.js",
        );
        const uncertain = new UpdateCommandRecoveryPendingError(
          "write-capable child remains unsettled",
        );
        const command = vi.spyOn(nativeCommand, "runUpdatedInstallGatewayCommand");
        if (scenario === "unsettled-child") {
          command.mockRejectedValueOnce(uncertain);
        }
        // Drive the real service and command catch boundaries. Only transport setup
        // and the compensation leaf are inert; no definition or process is mutated.
        mocks.restartService.mockImplementationOnce((params) =>
          actual.maybeRestartService({
            ...params,
            shouldRestart: true,
            refreshServiceEnv: true,
            serviceRuntimeRefreshRequired: true,
            serviceInstallEnv: {},
            originalManagedServiceRuntime: original,
            serviceUpdateVerdict: undefined,
            result: { ...params.result, root: home },
          }),
        );
        const rollback = vi
          .spyOn(rollbackModule, "rollbackFailedUpdate")
          .mockImplementationOnce(async ({ result, originalManagedServiceRuntime }) => {
            expect(originalManagedServiceRuntime).toBe(original);
            return { result, rolledBack: false, originalServiceRecovery: "healthy" };
          });
        const finishing = finishSuccessfulPackageSwitch(undefined, {
          originalManagedServiceRuntime: original,
        });
        if (scenario === "missing-entrypoint") {
          await expect(finishing).rejects.toMatchObject({
            name: "UpdateCommandFailure",
            result: { status: "error" },
          });
          expect(rollback).toHaveBeenCalledOnce();
        } else {
          await expect(finishing).rejects.toMatchObject({
            name: "UpdateCommandPendingRecoveryFailure",
            cause: uncertain,
          });
          expect(rollback).not.toHaveBeenCalled();
        }
        expect(command).toHaveBeenCalledOnce();
        await expect(command.mock.results[0]?.value).rejects.toMatchObject(
          scenario === "missing-entrypoint"
            ? { message: `updated install entrypoint not found under ${home}` }
            : { name: "UpdateCommandRecoveryPendingError" },
        );
      } finally {
        identity.restore();
      }
    },
  );
}
