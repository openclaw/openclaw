import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { registerMaintenanceCommands } from "../program/register.maintenance.js";
import { registerCurrentCoreServiceReceiptTests } from "./update-command-current-core-service-receipt.test-support.js";
import {
  createManagedServiceIdentityFixture,
  registerServiceInstallationConvergenceTests,
  finishSuccessfulPackageSwitch,
  expectFailureReport,
  expectUpdateFailure,
  managedServiceState,
  mockVerifiedGatewayRun,
  programArguments,
  registerForegroundFinalizationTests,
  registerManagedInstallEnvironmentTest,
  recordVerifiedGatewayRun,
  successfulPluginUpdate,
  taskRecovery,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = vi.hoisted(() => ({
  parkForeground: vi.fn(),
  checkCompletionStatus: vi.fn(),
  completePluginUpdate: vi.fn(),
  ensureCompletionCache: vi.fn(),
  loadPluginRecords: vi.fn(),
  markSentinelFailure: vi.fn(async () => undefined),
  printResult: vi.fn(),
  readConfig: vi.fn(),
  createServiceConfigIO: vi.fn(),
  readServiceState: vi.fn(),
  restartService: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  stopService:
    vi.fn<
      typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
    >(),
  revalidateService:
    vi.fn<
      typeof import("./update-command-service-revalidation.js").revalidateManagedGatewayServiceAfterUpdate
    >(),
  updatePlugins: vi.fn(),
  writeSentinel: vi.fn<
    typeof import("./update-command-result.js").writeControlPlaneUpdateRestartSentinelBestEffort
  >(async () => undefined),
}));

vi.mock("../../infra/update-managed-service-handoff.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-managed-service-handoff.js")>()),
  parkForegroundUpdateHandoff: mocks.parkForeground,
}));
vi.mock("./progress.js", () => ({ printResult: mocks.printResult }));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  createConfigIO: mocks.createServiceConfigIO,
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.readServiceState,
}));
vi.mock("../../commands/doctor-completion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/doctor-completion.js")>()),
  checkShellCompletionStatus: mocks.checkCompletionStatus,
  ensureCompletionCacheExists: mocks.ensureCompletionCache,
}));
vi.mock("../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: mocks.loadPluginRecords,
}));
vi.mock("./update-command-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config.js")>()),
  persistRequestedUpdateChannel: async (params: { configSnapshot: unknown }) =>
    params.configSnapshot,
  preparePostCorePluginConfig: async () => ({
    configSnapshot: await mocks.readConfig(),
    configWriteOptions: {},
    configChanged: false,
    restoredAuthoredChannels: [],
  }),
}));
vi.mock("./update-command-fresh-doctor.js", () => ({
  completePostCorePluginUpdate: mocks.completePluginUpdate,
}));
vi.mock("./update-command-plugins.js", () => ({
  updatePluginsAfterCoreUpdate: mocks.updatePlugins,
}));
vi.mock("./update-command-service-revalidation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-revalidation.js")>()),
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateService,
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restartService,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stopService,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  markControlPlaneUpdateRestartSentinelFailureBestEffort: mocks.markSentinelFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import * as postCoreModule from "./update-command-post-core.js";
import { registerBoundaryFinalizationControls } from "./update-command-post-update-boundary.test-support.js";
import { finishUpdate } from "./update-command-post-update.js";
import * as rollbackModule from "./update-command-rollback.js";
import { registerStaleSessionReceiptUpdateTest } from "./update-command-stale-session-receipt.test-support.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];
const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (stdinIsTTYDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
});

describe("successful update finalization ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // These roots are package fixtures; separate process tests cover Git discovery.
    vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
    mocks.readServiceState.mockReset();
    mocks.restartService.mockReset().mockResolvedValue("ok");
    mocks.stopService.mockReset();
    mocks.loadPluginRecords.mockResolvedValue({});
    mocks.revalidateService.mockReset();
    mocks.revalidateService.mockImplementation(async ({ root, preManagedServiceStop }) => ({
      kind: "owned",
      root,
      fingerprint: "sealed",
      refreshDefinition:
        preManagedServiceStop?.serviceUpdateVerdict?.kind === "owned"
          ? preManagedServiceStop.serviceUpdateVerdict.refreshDefinition
          : true,
    }));
    mocks.readConfig.mockResolvedValue(validConfigSnapshot);
    mocks.createServiceConfigIO.mockReturnValue({ readBestEffortConfig: async () => ({}) });
    mocks.updatePlugins.mockReset().mockResolvedValue(successfulPluginUpdate);
    mocks.completePluginUpdate.mockReset().mockResolvedValue({
      pluginUpdate: successfulPluginUpdate,
      configSnapshot: validConfigSnapshot,
    });
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  });

  registerForegroundFinalizationTests({ tempDirs, mocks });
  registerStaleSessionReceiptUpdateTest(mocks);
  registerCurrentCoreServiceReceiptTests({
    makeHome: () => tempDirs.make("current-core-service-receipt-"),
    mocks,
  });
  registerServiceInstallationConvergenceTests(() => tempDirs.make("update-install-drift-"), mocks);

  it("keeps an absent service out of already-current maintenance steps", async () => {
    const message = "Gateway restart skipped: no Gateway service or listener is running.";
    await finishSuccessfulPackageSwitch(
      {},
      {
        coreAlreadyCurrent: true,
        mutationStarted: false,
        result: {
          status: "skipped",
          reason: "already-current",
          mode: "npm",
          steps: [],
          durationMs: 0,
        },
        preManagedServiceStop: {
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: false,
          serviceMutationAllowed: false,
          serviceMutationSkipMessage: message,
          serviceUpdateVerdict: { kind: "absent" },
        },
      },
    );
    expect(mocks.restartService).not.toHaveBeenCalled();
    expect(mocks.stopService).not.toHaveBeenCalled();
    expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
      status: "skipped",
      reason: "already-current",
      steps: [],
    });
    expect(defaultRuntime.error).toHaveBeenCalledWith(message);
  });

  it("refuses same-schema finalization after requester revocation", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("finalizer-revoked-requester-") };
    const record = createUpdateRun({ trigger: "cli" }, { env });
    await expect(
      finishSuccessfulPackageSwitch({
        run: {
          runId: record.runId,
          env,
          executorFence: { assertCurrent() {} },
          requesterAuthority: { requester: {}, isCurrent: () => false },
        },
      }),
    ).rejects.toThrow("requester-revoked");
    expect(mocks.updatePlugins).not.toHaveBeenCalled();
    expect(mocks.restartService).not.toHaveBeenCalled();
    expect(getUpdateRun(record.runId, { env })?.status).toBe("running");
  });

  it("does not finalize or clean an active durable run without its live executor", async () => {
    const home = tempDirs.make("finalizer-pending-recovery-");
    const env = { HOME: home, OPENCLAW_STATE_DIR: home };
    const run = createUpdateRun({ trigger: "cli" }, { env });
    const runtime = { root: home, nodePath: process.execPath, version: "1.0.0", buildId: null };
    const record = createRetainedUpdateRecovery(
      { runId: run.runId, from: runtime, to: runtime },
      { env },
    );
    const complete = vi.fn(async () => undefined);
    await expect(
      finishSuccessfulPackageSwitch(
        { run: { runId: run.runId, env } },
        {
          packageTransaction: { backupRoot: home, rollback: vi.fn(), complete },
        },
      ),
    ).rejects.toMatchObject({
      name: "UpdateCommandPendingRecoveryFailure",
      cause: { name: "UpdateRecoveryRequiredError" },
      result: { status: "error", recovery: { serviceRestartSafe: false } },
    });
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.restartService).not.toHaveBeenCalled();
    expect(mocks.printResult).not.toHaveBeenCalled();
    expect(loadUpdateRecovery(run.runId, { env })).toEqual(record);
  });

  registerBoundaryFinalizationControls({ makeTempDir: (prefix) => tempDirs.make(prefix), mocks });

  it.each(["local", "fresh"] as const)(
    "keeps service activation behind awaited %s convergence and Doctor",
    async (execution) => {
      const identity = createManagedServiceIdentityFixture(
        tempDirs.make("update-convergence-order-"),
      );
      mocks.readServiceState.mockResolvedValue(managedServiceState(process.env));
      mocks.stopService.mockResolvedValue({
        inspected: true,
        runtimeInspected: true,
        running: true,
        stopped: true,
      });
      const events: string[] = [];
      const entered = createDeferred();
      const release = createDeferred();
      const plugins = { ...successfulPluginUpdate, changed: true };
      const converge = async () => {
        events.push("plugins");
        entered.resolve();
        await release.promise;
        return plugins;
      };
      vi.spyOn(postCoreModule, "shouldResumePostCoreUpdateInFreshProcess").mockReturnValue(
        execution === "fresh",
      );
      if (execution === "fresh") {
        vi.spyOn(postCoreModule, "continuePostCoreUpdateInFreshProcess").mockImplementationOnce(
          async () => ({ resumed: true, pluginUpdate: await converge() }),
        );
      } else {
        mocks.updatePlugins.mockImplementationOnce(converge);
      }
      mocks.completePluginUpdate.mockImplementationOnce(
        async (params: { beforeDoctor?: () => Promise<void> }) => {
          await params.beforeDoctor?.();
          events.push("doctor");
          return { pluginUpdate: plugins, configSnapshot: validConfigSnapshot };
        },
      );
      const recovery = taskRecovery((phase) => events.push(phase));
      mocks.restartService.mockImplementationOnce(async () => {
        events.push("start");
        return "ok";
      });
      const onGatewayStartAttempted = vi.fn(() => events.push("activation-attempt"));
      const finishing = finishSuccessfulPackageSwitch(
        {
          restartEnvironment: process.env,
          windowsTaskAutoStartRecovery: recovery,
        },
        {},
        { onGatewayStartAttempted },
      );
      try {
        try {
          await Promise.race([
            entered.promise,
            finishing.then(() => {
              throw new Error("Update completed before plugin convergence entered.");
            }),
          ]);
          expect.soft(mocks.restartService).not.toHaveBeenCalled();
          expect.soft(recovery.restore).not.toHaveBeenCalled();
          expect.soft(onGatewayStartAttempted).not.toHaveBeenCalled();
        } finally {
          release.resolve();
        }
        await finishing;
      } finally {
        identity.restore();
      }
      expect(events.indexOf("doctor")).toBeLessThan(events.indexOf("restore"));
      expect(events.indexOf("doctor")).toBeLessThan(events.indexOf("start"));
      expect(events.indexOf("doctor")).toBeLessThan(events.indexOf("activation-attempt"));
      expect(events.indexOf("activation-attempt")).toBeLessThan(events.indexOf("restore"));
      expect(events.indexOf("activation-attempt")).toBeLessThan(events.indexOf("start"));
      expect(mocks.restartService).toHaveBeenCalledOnce();
      expect(mocks.stopService).not.toHaveBeenCalled();
    },
  );

  it("restarts after completion status inspection fails", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.checkCompletionStatus.mockRejectedValueOnce(
      Object.assign(new Error("EACCES: completion profile read denied"), { code: "EACCES" }),
    );

    await expect.soft(finishSuccessfulPackageSwitch()).resolves.toBeUndefined();

    const output = vi.mocked(defaultRuntime.log).mock.calls.flat().map(String).join("\n");
    expect.soft(output).toContain("Shell completion refresh failed");
    expect.soft(output).toContain("Resolve the reported error before retrying");
    expect.soft(output).not.toContain("session only");
    expect.soft(mocks.restartService).toHaveBeenCalledOnce();
    expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.checkCompletionStatus.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("restarts when completion cache refresh reports failure", async () => {
    const root = tempDirs.make("openclaw-completion-failure-");
    await fs.writeFile(
      path.join(root, "openclaw.mjs"),
      'process.stderr.write("injected completion cache failure"); process.exit(1);',
    );

    await finishSuccessfulPackageSwitch({
      packageRoot: root,
      restartEnvironment: process.env,
    });

    const logCalls = vi.mocked(defaultRuntime.log).mock.calls;
    const warningIndex = logCalls.findIndex((call) =>
      call.some((value) => String(value).includes("Completion cache update failed")),
    );
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(defaultRuntime.log).mock.invocationCallOrder[warningIndex] ??
        Number.POSITIVE_INFINITY,
    );
    expect(logCalls[warningIndex]?.join(" ")).toContain("openclaw completion --write-state");
  });

  it("restarts when shell completion cache generation returns false", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", undefined);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.checkCompletionStatus.mockResolvedValueOnce({
      shell: "zsh",
      profileInstalled: true,
      cacheExists: true,
      cachePath: "/tmp/openclaw-completion.zsh",
      usesSlowPattern: true,
    });
    mocks.ensureCompletionCache.mockResolvedValueOnce(false);

    await finishSuccessfulPackageSwitch();

    const output = vi.mocked(defaultRuntime.log).mock.calls.flat().map(String).join("\n");
    expect(output).toContain("completion cache generation failed");
    expect(output).toContain("Resolve the reported error before retrying");
    expect(output).not.toContain("source /tmp/openclaw-completion.zsh");
    expect(output).toContain("openclaw completion --write-state --install");
    expect(mocks.restartService).toHaveBeenCalledOnce();
    expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureCompletionCache.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("reports Windows autostart recovery failure before exiting", async () => {
    const restoreError = new Error("task restore failed");
    const restore = vi.fn(async () => {
      throw restoreError;
    });

    await expectUpdateFailure(
      finishSuccessfulPackageSwitch({
        restartEnvironment: process.env,
        json: true,
        windowsTaskAutoStartRecovery: {
          ...taskRecovery(),
          restore,
        },
      }),
      "windows-task-autostart-restore-failed",
      { cause: restoreError, detail: expect.stringContaining(restoreError.message) },
    );

    expect(restore).toHaveBeenCalledOnce();
    expect(mocks.restartService).not.toHaveBeenCalled();
    expect(mocks.printResult).toHaveBeenCalledOnce();
    expectFailureReport(
      mocks.printResult,
      "windows-task-autostart-restore-failed",
      expect.objectContaining({ json: true }),
    );
    expect(mocks.writeSentinel.mock.lastCall?.[0].result).toEqual(
      mocks.printResult.mock.lastCall?.[0],
    );
  });

  it.each([
    { name: "retires the wrapper before persisting and printing success", denied: false },
    {
      name: "recovers and retains the package before reporting failed wrapper retirement",
      denied: true,
    },
  ])("$name", async ({ denied }) => {
    const home = tempDirs.make("openclaw-finalize-wrapper-");
    const previousRoot = path.join(home, "old-root");
    const wrapper = path.join(home, ".local", "bin", "openclaw");
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.writeFile(
      wrapper,
      `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${previousRoot}/dist/entry.js "$@"\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", path.dirname(wrapper));
    const unlink = vi.spyOn(fs, "unlink");
    if (denied) {
      unlink.mockRejectedValueOnce(new Error("unlink denied"));
    }
    const rollback = vi
      .spyOn(rollbackModule, "rollbackFailedUpdate")
      .mockImplementationOnce(async ({ result }) => ({ result, rolledBack: false }));
    const retained = {
      name: "package backup retained",
      command: "openclaw update",
      cwd: previousRoot,
      durationMs: 0,
      exitCode: 0,
      stderrTail: "Retained previous package for recovery.",
    };
    const complete = vi.fn<NonNullable<FinishUpdateParams["packageTransaction"]>["complete"]>(
      async ({ activationVerified }) => (activationVerified ? undefined : retained),
    );
    const finishing = finishSuccessfulPackageSwitch(
      { previousRoot, packageRoot: path.join(home, "package") },
      { packageTransaction: { backupRoot: previousRoot, rollback: vi.fn(), complete } },
    );
    if (denied) {
      await expectUpdateFailure(finishing, "wrapper-retirement-failed", {
        detail: expect.stringContaining("unlink denied"),
      });
      expect(rollback).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        { activationVerified: false },
        expect.any(Function),
      );
      expect(mocks.printResult).toHaveBeenCalledOnce();
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
        status: "error",
        steps: expect.arrayContaining([retained]),
      });
      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      expectFailureReport(mocks.printResult, "wrapper-retirement-failed");
      expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "wrapper-retirement-failed" }),
      );
    } else {
      await finishing;
      expect(mocks.writeSentinel).toHaveBeenCalledTimes(2);
      expect(unlink.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.writeSentinel.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
      );
      expect(mocks.writeSentinel.mock.invocationCallOrder[1]).toBeLessThan(
        mocks.printResult.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    }
  });

  registerManagedInstallEnvironmentTest({ tempDirs, mocks });

  describe("managed service finalization", () => {
    let identity: ReturnType<typeof createManagedServiceIdentityFixture>;
    beforeEach(() => {
      identity = createManagedServiceIdentityFixture(
        tempDirs.make("openclaw-post-update-service-home-"),
      );
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      identity.restore();
    });

    it.each([
      { outcome: "unchanged", stoppedAtMs: 500, downtimeMs: 10_700 },
      { outcome: "rolled-back", stoppedAtMs: 500, downtimeMs: 11_500 },
      { outcome: "unverified", stoppedAtMs: 500, downtimeMs: null },
    ] as const)(
      "keeps plugin convergence stopped and measures the full interval through verification ($outcome, initial stop=$stoppedAtMs)",
      async ({ outcome, stoppedAtMs, downtimeMs }) => {
        const changed = outcome !== "unchanged";
        const restartFailed = outcome === "rolled-back" || outcome === "unverified";
        const packageRoot = tempDirs.make("update-downtime-installed-runtime-");
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ version: "2026.4.24" }),
        );
        const serviceEnv = {
          ...process.env,
          HOME: identity.home,
          OPENCLAW_STATE_DIR: identity.home,
        };
        const run = {
          runId: createUpdateRun({ trigger: "cli" }, { env: serviceEnv }).runId,
          env: serviceEnv,
        };
        const clock = { origin: Date.now(), elapsed: 1_000 };
        vi.spyOn(Date, "now").mockImplementation(() => clock.origin + clock.elapsed);
        const events: string[] = [];
        const windowsEvents: string[] = [];
        const oldRecovery = taskRecovery((phase) => {
          if (phase === "complete") {
            windowsEvents.push("old-complete");
          }
        });
        mocks.readServiceState.mockResolvedValue(
          managedServiceState(serviceEnv, { environment: serviceEnv }),
        );
        mocks.restartService.mockImplementation(async (params) => {
          events.push("start");
          clock.elapsed += events.length === 1 ? 500 : 200;
          if (restartFailed && events.length > 1) {
            recordUpdateRunVerification(run.runId, { serviceRunning: false }, { env: serviceEnv });
            return "restart-health-failed";
          }
          recordVerifiedGatewayRun(run);
          params.onVerified?.(Date.now());
          return "ok";
        });
        const plugins = { ...successfulPluginUpdate, changed };
        mocks.updatePlugins.mockImplementationOnce(async () => {
          events.push("plugins");
          clock.elapsed = 11_000;
          return plugins;
        });
        mocks.completePluginUpdate.mockImplementationOnce(
          async (params: { beforeDoctor?: () => Promise<void> }) => {
            if (changed) {
              await params.beforeDoctor?.();
              events.push("doctor");
              expect(windowsEvents).toEqual([]);
              clock.elapsed += 300;
            }
            return { pluginUpdate: plugins, configSnapshot: validConfigSnapshot };
          },
        );
        vi.spyOn(rollbackModule, "rollbackFailedUpdate").mockImplementationOnce(
          async ({ result }): ReturnType<typeof rollbackModule.rollbackFailedUpdate> => {
            expect(result.reason, JSON.stringify(result.steps)).toBe("restart-unhealthy");
            events.push("rollback");
            expect(getUpdateRun(run.runId, { env: serviceEnv })?.confirmedAtMs).toBeNull();
            clock.elapsed = 12_000;
            if (outcome === "rolled-back") {
              await fs.writeFile(
                path.join(packageRoot, "package.json"),
                JSON.stringify({ version: "2026.4.23" }),
              );
              mockVerifiedGatewayRun(run);
            }
            return {
              result: {
                ...result,
                after: result.before,
                recovery:
                  outcome === "rolled-back"
                    ? {
                        serviceRestartSafe: true,
                        version: "2026.4.23",
                        packageRollbackVerified: true,
                        service: "healthy",
                      }
                    : {
                        serviceRestartSafe: false,
                        packageRollbackVerified: true,
                        reason: "runtime-verification-failed",
                      },
              },
              rolledBack: outcome === "rolled-back",
              ...(outcome === "rolled-back" ? { verifiedAtMs: Date.now() } : {}),
            };
          },
        );
        const finishing = finishSuccessfulPackageSwitch(
          {
            packageRoot,
            restartEnvironment: serviceEnv,
            sealed: true,
            stoppedAtMs: clock.origin + stoppedAtMs,
            run,
            windowsTaskAutoStartRecovery: oldRecovery,
          },
          restartFailed
            ? {
                packageTransaction: {
                  backupRoot: "/tmp/previous-openclaw",
                  rollback: vi.fn(),
                  complete: vi.fn(async () => undefined),
                },
              }
            : {},
        );
        if (restartFailed) {
          await expect(finishing).rejects.toMatchObject({
            result: {
              status: "error",
              recovery: { serviceRestartSafe: outcome === "rolled-back" },
            },
          });
        } else {
          await finishing;
        }
        expect(events).toEqual([
          "plugins",
          ...(changed ? ["doctor"] : []),
          "start",
          ...(restartFailed ? ["rollback"] : []),
        ]);
        expect(mocks.stopService).not.toHaveBeenCalled();
        expect(oldRecovery.restore.mock.lastCall?.slice(0, 2)).toEqual([
          true,
          expect.any(Function),
        ]);
        expect(oldRecovery.complete).toHaveBeenLastCalledWith(outcome !== "unverified");
        expect(windowsEvents.at(-1)).toBe("old-complete");
        expect(getUpdateRun(run.runId, { env: serviceEnv })).toMatchObject({
          status:
            outcome === "rolled-back" ? "rolled-back" : restartFailed ? "failed" : "succeeded",
          downtimeMs,
        });
      },
    );

    it("skips unsafe metadata refresh for unknown ownership", async () => {
      const portArguments = [...programArguments, "--port", "19305"];
      mocks.readServiceState.mockResolvedValueOnce(
        managedServiceState(
          {},
          {
            programArguments: portArguments,
            managedDefinition: { programArguments: portArguments },
            managedOverrides: { environment: true },
          },
        ),
      );

      await finishSuccessfulPackageSwitch();

      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldRestart: true,
          refreshServiceEnv: false,
          serviceInstallEnv: null,
          serviceUpdateVerdict: expect.objectContaining({ refreshDefinition: false }),
        }),
      );
      expect(mocks.restartService.mock.lastCall?.[0].gatewayPort).toBe(19305);
    });

    it.each(["inspection", "revalidation"] as const)(
      "does not restart a stopped sealed service when fresh %s fails",
      async (failure) => {
        let now = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => now);
        mocks.writeSentinel.mockImplementationOnce(async () => {
          now += 100;
        });
        const error = new Error("inspection-secret-canary");
        mocks.readServiceState.mockResolvedValue(managedServiceState());
        if (failure === "inspection") {
          mocks.readServiceState.mockRejectedValueOnce(error);
        } else {
          mocks.revalidateService.mockRejectedValueOnce(error);
        }
        await expectUpdateFailure(
          finishSuccessfulPackageSwitch({
            restartEnvironment: { ...process.env },
            sealed: true,
            json: true,
          }),
          "service-revalidation-failed",
        );

        expect(mocks.restartService).not.toHaveBeenCalled();
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          "Stopped gateway service could not be revalidated; inspect it before restarting manually.",
        );
        expect(mocks.printResult).toHaveBeenCalledOnce();
        expectFailureReport(
          mocks.printResult,
          "service-revalidation-failed",
          expect.objectContaining({ json: true }),
        );
        expect(mocks.writeSentinel.mock.lastCall?.[0].result).toEqual(
          mocks.printResult.mock.lastCall?.[0],
        );
      },
    );

    it.each([
      {
        name: "marks failed activation without finalizing success",
        activated: false,
        unloaded: false,
      },
      {
        name: "preserves the native context of an unloaded git service",
        activated: true,
        unloaded: true,
      },
    ])("canonical sealed post-update $name", async ({ activated, unloaded }) => {
      const serviceEnv = { MANAGED_VALUE: "revalidated" };
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("update-retention-fact-") };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      mocks.readServiceState.mockResolvedValueOnce(
        managedServiceState(serviceEnv, { environment: serviceEnv }, unloaded),
      );
      mocks.restartService.mockImplementationOnce(async (params) => {
        if (!activated) {
          params.onVerificationFailure?.("readyz-unhealthy");
        }
        return activated ? "ok" : "failed";
      });
      const finishing = finishSuccessfulPackageSwitch({
        restartEnvironment: { ...process.env },
        sealed: true,
        updateMode: unloaded ? "git" : "npm",
        stoppedForUpdate: !unloaded,
        run,
      });
      if (activated) {
        await finishing;
      } else {
        await expectUpdateFailure(finishing, "readyz-unhealthy");
      }

      expect(mocks.restartService).toHaveBeenCalledOnce();
      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshServiceEnv: false,
          serviceEnv,
          serviceUpdateVerdict: {
            kind: "owned",
            root: "/tmp/openclaw-update",
            refreshDefinition: false,
            fingerprint: "sealed",
          },
          result: expect.objectContaining({
            after: { version: "2026.4.24", ...(unloaded ? { buildId: "new-build" } : {}) },
          }),
          requireRunningServiceAfterRestart: !unloaded,
        }),
      );
      expect(mocks.revalidateService.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.restartService.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      if (activated) {
        expect(mocks.writeSentinel).toHaveBeenCalledTimes(2);
        expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.writeSentinel.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
        );
      } else {
        expect(mocks.writeSentinel).toHaveBeenCalledOnce();
        expect(mocks.printResult).toHaveBeenCalledOnce();
        expectFailureReport(mocks.printResult, "readyz-unhealthy");
        expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "readyz-unhealthy" }),
        );
        expect(getUpdateRun(run.runId, { env })).toMatchObject({
          status: "failed",
          reason: "readyz-unhealthy",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "package rollback",
              status: "skipped",
              detail:
                "No retained previous package transaction is available; automatic package restoration was not attempted.",
            }),
          ]),
        });
      }
    });

    it("leaves native service management blocked when HOME is relocated", async () => {
      const home = tempDirs.make("openclaw-post-update-relocated-home-");
      process.env.HOME = home;
      process.env.USERPROFILE = home;

      await finishSuccessfulPackageSwitch({
        packageRoot: home,
        restartEnvironment: { ...process.env },
        stoppedForUpdate: false,
      });

      expect(mocks.readServiceState).not.toHaveBeenCalled();
      expect(mocks.revalidateService).not.toHaveBeenCalled();
      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldRestart: false,
          serviceMutationSkipMessage: expect.stringContaining("HOME set to the OS account home"),
        }),
      );
    });
  });

  it.each([
    { owner: "original updater", candidateRuntime: false, marker: false, runs: true, ready: true },
    {
      owner: "migrated worker with the marker",
      candidateRuntime: true,
      marker: true,
      runs: true,
      ready: true,
    },
    {
      owner: "worker from a shipped updater",
      candidateRuntime: true,
      marker: false,
      runs: false,
      ready: true,
    },
    {
      owner: "unverified Gateway",
      candidateRuntime: false,
      marker: false,
      runs: true,
      ready: false,
    },
  ])(
    "runs deferred Doctor inspections after the restart for the $owner",
    async ({ candidateRuntime, marker, runs, ready }) => {
      const root = tempDirs.make("post-activation-inspections-");
      const lintLog = path.join(root, "lint.json");
      const findings = [
        ...(!candidateRuntime
          ? [
              {
                checkId: "core/doctor/runtime-tool-schemas",
                severity: "warning",
                message: "Plugin drift.",
              },
            ]
          : []),
        {
          checkId: "core/doctor/command-owner",
          severity: "info",
          message: "No command owner is configured.",
        },
      ];
      await fs.mkdir(path.join(root, "dist"));
      await fs.writeFile(
        path.join(root, "dist", "index.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(lintLog)}, JSON.stringify({ argv: process.argv.slice(2), inProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS ?? null }));
process.stdout.write(${JSON.stringify(JSON.stringify({ ok: false, checksRun: 3, findings }))});
process.exitCode = 1;
`,
      );
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      if (marker) {
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS", "1");
      }
      const plugins = { ...successfulPluginUpdate, changed: false };
      mocks.updatePlugins.mockResolvedValue(plugins);
      mocks.completePluginUpdate.mockImplementation(async ({ beforeDoctor }) => {
        await beforeDoctor?.();
        expect(process.env.OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS).toBe(
          runs ? "1" : "0",
        );
        return { pluginUpdate: plugins, configSnapshot: validConfigSnapshot };
      });
      const events: string[] = [];
      mocks.restartService.mockImplementation(async ({ onVerified }) => {
        events.push(
          await fs.stat(lintLog).then(
            () => "restart after lint",
            () => "restart",
          ),
        );
        if (ready) {
          onVerified?.(Date.now());
        }
        return "ok";
      });
      const doctorStep = {
        name: "openclaw doctor",
        command: "openclaw doctor --fix",
        cwd: root,
        durationMs: 1,
        exitCode: 0,
      };
      const initialSteps = [doctorStep];

      await finishSuccessfulPackageSwitch(
        {
          packageRoot: root,
          restartEnvironment: process.env,
          sealed: false,
          stoppedForUpdate: true,
        },
        {
          result: { status: "ok", mode: "npm", root, steps: initialSteps, durationMs: 1 },
          packageUpdateNodeRunner: process.execPath,
        },
        { candidateRuntime },
      );

      expect(events).toEqual(["restart"]);
      const steps = mocks.printResult.mock.lastCall?.[0].steps;
      if (!runs) {
        await expect(fs.stat(lintLog)).rejects.toThrow();
        expect(steps).toEqual(initialSteps);
        return;
      }
      if (!ready) {
        await expect(fs.stat(lintLog)).rejects.toThrow();
        expect(steps).toEqual([
          ...initialSteps,
          expect.objectContaining({
            name: "post-activation doctor inspections",
            advisory: expect.objectContaining({
              kind: "recoverable-maintenance",
              message: expect.stringContaining("Gateway readiness was not verified"),
            }),
          }),
        ]);
        expect(mocks.printResult.mock.lastCall?.[0].status).toBe("ok");
        return;
      }
      const lint = JSON.parse(await fs.readFile(lintLog, "utf8"));
      const program = new Command();
      registerMaintenanceCommands(program);
      const doctor = program.commands.find((command) => command.name() === "doctor");
      assert(doctor);
      doctor.parseOptions(lint.argv.slice(1));
      const options = doctor.opts();
      expect(options.severityMin).toBe("info");
      expect(options.only).toHaveLength(12);
      expect(options.only).toEqual(
        expect.arrayContaining([
          "core/doctor/hooks-model",
          "core/doctor/runtime-tool-schemas",
          "core/doctor/provider-catalog-projection",
        ]),
      );
      expect(options.only).not.toContain("core/doctor/security");
      expect(options.only).not.toContain("core/doctor/session-snapshots");
      expect(options.only).not.toContain("core/doctor/workspace-status");
      expect(lint.inProgress).toBeNull();
      expect(steps).toEqual([
        ...initialSteps,
        expect.objectContaining({
          name: "post-activation doctor inspections",
          exitCode: 1,
          ...(!candidateRuntime
            ? { warnings: ["core/doctor/runtime-tool-schemas: Plugin drift."] }
            : {}),
          doctorLintFindings: findings,
          advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
        }),
      ]);
      expect(mocks.printResult.mock.lastCall?.[0].status).toBe("ok");
    },
  );
});
