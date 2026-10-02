import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import * as stepWrites from "../infra/update-run-write.async.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import {
  expectNoSideEffects,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  launchdUpdateCleanupMocks,
  readPackageVersion,
  serviceLoaded,
  serviceRestart,
  serviceStart,
  serviceStop,
  stateSchemaVersions,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  doctorCommand,
  ExitError,
  expectUpdateFailureReport,
  getUpdateRun,
  invokeUpdateCli,
  listUpdateRuns,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveUpdateInstallKind,
  runDaemonInstall,
  runDaemonRestart,
  updateCommand,
  updateFinalizeCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseSnapshot,
    initializeExistingUpdateProfile,
    mockCurrentProcessFreshDoctor,
    mockGatewayHealth,
    mockOwnedGitService,
    mockPackageInstallAtCaseDir,
    tempDirs,
  } = createUpdateCliFixture();

  it.each([
    { installKind: "package", installedVersion: "2026.9.3" },
    { installKind: "git", installedVersion: null },
  ] as const)(
    "registered update CLI previews known versions for $installKind ($installedVersion)",
    async ({ installKind, installedVersion }) => {
      await mockPackageInstallAtCaseDir("openclaw-preview-version");
      vi.mocked(resolveUpdateInstallKind).mockResolvedValue(installKind);
      readPackageVersion.mockResolvedValue(installedVersion);
      vi.mocked(readConfigFileSnapshot).mockResolvedValue({
        ...baseSnapshot,
        config: { update: { channel: "dev" } },
      });

      await invokeUpdateCli({ dryRun: true, json: true, restart: false });

      expect(lastWriteJsonCall()).toMatchObject({
        currentVersion: installedVersion ?? VERSION,
        targetVersion: null,
        targetVersionReason: expect.stringContaining("Git"),
        switchToGit: installKind === "package",
        run: {
          before: { version: installedVersion ?? VERSION },
          status: "skipped",
          reason: "dry-run",
        },
      });
      await invokeUpdateCli({ dryRun: true, restart: false });
      expect(getLogOutput()).toContain(`Current version: ${installedVersion ?? VERSION}`);
      expect(getLogOutput()).toContain("Target version: unresolved");
      expectNoSideEffects(updateGitCheckout, replaceConfigFile, runDaemonInstall, runDaemonRestart);
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

  it("does not clean managed-service handoffs during a JSON dry run", async () => {
    const stateDir = tempDirs.make("openclaw-update-run-preview-");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await updateCommand({ dryRun: true, json: true, channel: "beta", acceptCapabilities: true });
      const output = lastWriteJsonCall() as { runId: string };
      expect(readConfigFileSnapshot).toHaveBeenCalledWith({
        skipPluginValidation: true,
        observe: false,
      });
      expect(listUpdateRuns()).toMatchObject([
        {
          runId: output.runId,
          trigger: "cli",
          phase: "finished",
          status: "skipped",
          reason: "dry-run",
        },
      ]);
    });

    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expectNoSideEffects(
      replaceConfigFile,
      updateGitCheckout,
      runDaemonInstall,
      syncPluginsForUpdateChannel,
      updateNpmInstalledPlugins,
    );
    expect(defaultRuntime.writeJson).toHaveBeenCalled();
  });

  it.each(["progress initialization", "triage preparation"] as const)(
    "finishes the admitted run when %s fails before update execution",
    async (boundary) => {
      const { closeOpenClawStateDatabaseByPath } =
        await import("../state/openclaw-state-db-cache.js");
      const stateDir = tempDirs.make("openclaw-update-run-initialization-");
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
      const failure = new Error(`${boundary} failed`);
      if (boundary === "progress initialization") {
        const progress = await import("./update-cli/progress.js");
        vi.spyOn(progress, "createUpdateProgress").mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        const triage = await import("../infra/update-triage.js");
        vi.spyOn(triage, "prepareUpdateFailureTriage").mockRejectedValueOnce(failure);
      }

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const reported = await updateCommand({ yes: true, json: true }).catch(
          (error: unknown) => error,
        );
        const runs = listUpdateRuns();
        if (boundary === "progress initialization") {
          expect(reported).toEqual(new ExitError(1));
          expect(lastWriteJsonCall()).toMatchObject({
            status: "error",
            reason: "update-failed",
            runId: runs[0]?.runId,
            reportPath: expect.any(String),
          });
          expect(JSON.stringify(lastWriteJsonCall())).toContain(failure.message);
        } else {
          expectUpdateFailureReport(reported, failure, lastWriteJsonCall(), runs[0]?.runId);
        }
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
          trigger: "cli",
          phase: "finished",
          status: "failed",
          reason: "update-failed",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "requested",
              status: "failed",
              detail: `Exit code: 1; ${boundary} failed`,
              exitCode: 1,
              failureFacts: [
                expect.objectContaining({ check: "requested", message: failure.message }),
              ],
            }),
          ]),
        });
        expect(runs[0]?.steps.some((step) => step.status === "in_progress")).toBe(false);
      }).finally(() => {
        closeOpenClawStateDatabaseByPath(
          resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: stateDir }),
        );
      });

      expectNoSideEffects(
        cleanupStaleManagedServiceUpdateHandoffs,
        replaceConfigFile,
        updateGitCheckout,
        runDaemonInstall,
        runDaemonRestart,
        serviceStop,
        serviceStart,
        serviceRestart,
        doctorCommand,
        syncPluginsForUpdateChannel,
        updateNpmInstalledPlugins,
        launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(freshRestartCalls()).toHaveLength(0);
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

  it("leaves restored-generation completion with the helper across updateCommand unwind", async () => {
    const postUpdate = await import("./update-cli/update-command-post-update.js");
    const { UpdateCommandFailure } = await import("./update-cli/update-command-result.js");
    const { finishUpdateRun } = await import("../infra/update-run-ledger.js");
    const result = makeOkUpdateResult({
      status: "error",
      root: process.cwd(),
      reason: "restart-unhealthy",
      before: { version: "2026.9.1" },
      after: { version: "2026.9.1" },
      recovery: {
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        version: "2026.9.1",
      },
    });
    const failure = new UpdateCommandFailure(result);
    vi.spyOn(postUpdate, "finishUpdate").mockImplementationOnce(async (_params, options) => {
      await options?.beforeFinalization?.();
      throw failure;
    });
    mockOwnedGitService();
    mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));

    await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: "1" }, async () => {
      await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

      expect(postUpdate.finishUpdate).toHaveBeenCalledOnce();
      const run = expectDefined(listUpdateRuns({ limit: 1 })[0], "helper-owned update run");
      expect(run).toMatchObject({ status: "running", after: { version: "2026.9.1" } });
      // Native recovery finishes after the CLI exits; the ledger must still accept its outcome.
      finishUpdateRun(run.runId, { status: "rolled-back", reason: result.reason });
      expect(getUpdateRun(run.runId)).toMatchObject({
        status: "rolled-back",
        phase: "finished",
        reason: "restart-unhealthy",
      });
    });
  });

  it("does not reopen the ledger after migrated finalization fails", async () => {
    const migrated = await import("./update-cli/update-command-migrated.js");
    const ledgerReads = vi.spyOn(await import("../infra/update-run-ledger.js"), "getUpdateRun");
    const failure = new Error("candidate finalization failed");
    let readsAtHandoff = 0;
    vi.spyOn(migrated, "inspectActivatedUpdateState").mockResolvedValueOnce(
      "state-migrated-no-rollback",
    );
    vi.spyOn(migrated, "continueMigratedUpdateInFreshProcess").mockImplementationOnce(async () => {
      readsAtHandoff = ledgerReads.mock.calls.length;
      throw failure;
    });
    mockOwnedGitService();
    mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));

    await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

    expect(migrated.continueMigratedUpdateInFreshProcess).toHaveBeenCalledOnce();
    expect(ledgerReads).toHaveBeenCalledTimes(readsAtHandoff);
  });

  it.each(["confirmed", "unknown"] as const)(
    "records ordered update phases only after buffered receipt settlement (%s)",
    async (outcome) => {
      const json = false;
      const progressReads = await import("../infra/update-run-reader.js");
      const readProgress = progressReads.getUpdateRunForProgressAsync;
      const heldReads: ReturnType<typeof readProgress>[] = [];
      const readSignals: AbortSignal[] = [];
      const releaseReads = new Set<() => void>();
      const progressReadSpy = vi
        .spyOn(progressReads, "getUpdateRunForProgressAsync")
        .mockImplementation((...args) => {
          const readSignal = expectDefined(args[2], "owned progress reader signal");
          readSignals.push(readSignal);
          const delayed = (async () => {
            const snapshot = structuredClone(await readProgress(...args));
            if (!readSignal.aborted) {
              await new Promise<void>((resolve) => {
                const release = () => {
                  readSignal.removeEventListener("abort", release);
                  releaseReads.delete(release);
                  resolve();
                };
                releaseReads.add(release);
                readSignal.addEventListener("abort", release, { once: true });
              });
            }
            return snapshot;
          })();
          heldReads.push(delayed);
          return delayed;
        });
      const prepareService = vi.spyOn(
        await import("./update-cli/update-command-post-update-maintenance.js"),
        "preparePostUpdateService",
      );
      const ledgerReads = vi.spyOn(await import("../infra/update-run-ledger.js"), "getUpdateRun");
      const inspectSchemas = expectDefined(
        stateSchemaVersions.getMockImplementation(),
        "schema inspection",
      );
      let observedActivation = false;
      stateSchemaVersions.mockImplementation(async (options) => {
        const versions = await inspectSchemas(options);
        if (serviceStop.mock.calls.length > 0 && !observedActivation) {
          // The real onActivation callback has run, but schema inspection has not
          // yet authorized this process to reopen the candidate's ledger.
          const progress = expectDefined(
            vi.mocked(updateGitCheckout).mock.calls[0]?.[0]?.opts.progress,
            "update progress",
          );
          const readsBefore = ledgerReads.mock.calls.length;
          await expectDefined(
            progress.onStepComplete,
            "step completion",
          )({
            name: "core migrations",
            command: "doctor --fix",
            index: 0,
            total: 1,
            durationMs: 1,
            exitCode: 0,
          });
          expect(ledgerReads).toHaveBeenCalledTimes(readsBefore);
          observedActivation = true;
        }
        return versions;
      });
      mockOwnedGitService();
      mockGitUpdateAfterMutation(
        makeOkUpdateResult({
          root: process.cwd(),
          before: { version: "0.9.0" },
          after: { version: VERSION },
        }),
      );
      // Candidate admission precedes the intentionally absent post-core handoff CLI.
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
        path.join(process.cwd(), "dist", "index.js"),
      );
      mockCurrentProcessFreshDoctor();
      mockGatewayHealth(VERSION, "updated-gateway");
      serviceLoaded.mockResolvedValue(true);
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(
        path.join(process.cwd(), "dist", "index.js"),
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const unknown = new SqliteWorkerError("buffered receipt reply lost", "outcome-unknown");
      let armed = false;
      let intercepted = false;
      let receiptCalls = 0;
      let receiptRunId: string | undefined;
      let receiptError: unknown;
      let workerReply: unknown;
      const runWorker = stateWorker.runOpenClawStateWorkerOperation;
      const worker = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation(async (...args) => {
          const target = armed;
          if (target) {
            armed = false;
            intercepted = true;
          }
          const reply = await runWorker(...args);
          if (target) {
            workerReply = reply;
            entered.resolve();
            await release.promise;
            if (outcome === "unknown") {
              throw unknown;
            }
          }
          return reply;
        });
      const writeStep = stepWrites.recordUpdateRunStepAsync;
      const writer = vi
        .spyOn(stepWrites, "recordUpdateRunStepAsync")
        .mockImplementation((...args) => {
          if (args[1].step !== "core migrations" || args[1].status !== "completed") {
            return writeStep(...args);
          }
          receiptCalls++;
          receiptRunId = args[0];
          armed = !intercepted;
          try {
            return writeStep(...args).catch((error: unknown) => {
              receiptError = error;
              throw error;
            });
          } finally {
            armed = false;
          }
        });
      const pending = updateCommand({ yes: true, json });
      const settled = pending.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await Promise.race([
          entered.promise,
          settled.then((result) => {
            throw new Error("Update finished without its buffered worker receipt", {
              cause: result.ok ? undefined : result.error,
            });
          }),
        ]);
        expect(observedActivation).toBe(true);
        expect(receiptCalls).toBe(1);
        expect(prepareService).not.toHaveBeenCalled();
        expect(freshRestartCalls()).toHaveLength(0);
        expect(runDaemonRestart).not.toHaveBeenCalled();
        const runId = expectDefined(receiptRunId, "buffered receipt run");
        expect(workerReply).toMatchObject({ kind: "recorded", record: { runId } });
        expect(getUpdateRun(runId)).toMatchObject({
          status: "running",
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "core migrations", status: "completed" }),
          ]),
        });
        release.resolve();
        const result = await settled;
        expect(receiptCalls).toBe(1);
        if (outcome === "unknown") {
          expect(result.ok).toBe(false);
          const cliError = result.ok ? undefined : result.error;
          expect(hasCommandProcessCleanupError(cliError)).toBe(true);
          expect(collectNestedErrorCandidates(cliError)).toContain(receiptError);
          expect(hasCommandProcessCleanupError(receiptError)).toBe(true);
          expect(collectNestedErrorCandidates(receiptError)).toContain(unknown);
          expect(prepareService).not.toHaveBeenCalled();
          expect(freshRestartCalls()).toHaveLength(0);
          expect(runDaemonRestart).not.toHaveBeenCalled();
          expect(serviceRestart).not.toHaveBeenCalled();
          expect(serviceStart).not.toHaveBeenCalled();
          const failed = expectDefined(getUpdateRun(runId), "uncertain receipt history");
          expect(failed.status).not.toBe("succeeded");
          expect(failed.steps).toContainEqual(
            expect.objectContaining({ step: "core migrations", status: "completed" }),
          );
          expect(defaultRuntime.writeJson).not.toHaveBeenCalledWith(
            expect.objectContaining({ status: "ok" }),
          );
          return;
        }
        if (!result.ok) {
          throw new Error(`${getErrorOutput()}\n${JSON.stringify(lastWriteJsonCall())}`, {
            cause: result.error,
          });
        }
        expect(observedActivation).toBe(true);
        expect(prepareService).toHaveBeenCalledOnce();
        expect(freshRestartCalls()).toHaveLength(1);
        expect(runDaemonRestart).not.toHaveBeenCalled();
        const run = expectDefined(listUpdateRuns({ limit: 1 })[0], "admitted update run");
        expect(serviceStop, getErrorOutput()).toHaveBeenCalledOnce();
        expect(run, getErrorOutput()).toMatchObject({
          trigger: "cli",
          status: "succeeded",
          phase: "finished",
          verification: { serviceRunning: true, runningVersion: VERSION },
        });
        expect(
          run?.steps
            .filter((step) =>
              [
                "requested",
                "staging",
                "validating",
                "activating",
                "restarting",
                "verifying",
              ].includes(step.step),
            )
            .map((step) => step.step),
        ).toEqual(["requested", "staging", "validating", "activating", "restarting", "verifying"]);
        expect(heldReads.length).toBeGreaterThan(0);
        expect(readSignals.every((signal) => signal.aborted)).toBe(true);
        const output = getLogOutput();
        const phases = output.split("\n").filter((line) => line.startsWith("Phase:"));
        expect(phases).toEqual([
          "Phase: requested",
          "Phase: staging",
          "Phase: validating",
          "Phase: activating",
          "Phase: restarting",
          "Phase: verifying",
          "Phase: finished",
        ]);
        expect(output.indexOf("OpenClaw updated")).toBeGreaterThan(
          output.indexOf("Phase: finished"),
        );
      } finally {
        release.resolve();
        await settled;
        writer.mockRestore();
        worker.mockRestore();
        prepareService.mockRestore();
        for (const releaseRead of releaseReads) {
          releaseRead();
        }
        await Promise.allSettled(heldReads);
        progressReadSpy.mockRestore();
      }
    },
  );

  it("does not clean managed-service handoffs before rejecting an invalid timeout", async () => {
    const runsBefore = listUpdateRuns();
    await invokeUpdateCli({ timeout: "" });

    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(listUpdateRuns()).toEqual(runsBefore);
  });

  it.each([
    { name: "update", run: async () => await invokeUpdateCli({ channel: "" }) },
    { name: "finalization", run: async () => await updateFinalizeCommand({ channel: "" }) },
  ])("rejects an explicitly empty $name channel before mutation", async ({ run }) => {
    await run();

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      '--channel must be "stable", "extended-stable", "beta", or "dev" (got "")',
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expectNoSideEffects(
      cleanupStaleManagedServiceUpdateHandoffs,
      replaceConfigFile,
      updateGitCheckout,
      doctorCommand,
      syncPluginsForUpdateChannel,
    );
  });
});
