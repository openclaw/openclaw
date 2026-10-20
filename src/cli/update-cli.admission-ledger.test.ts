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
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const f = createUpdateCliFixture();

  it.each([
    { installKind: "package", installedVersion: "2026.9.3" },
    { installKind: "git", installedVersion: null },
  ] as const)(
    "registered update CLI previews known versions for $installKind ($installedVersion)",
    async ({ installKind, installedVersion }) => {
      await f.mockPackageInstallAtCaseDir("openclaw-preview-version");
      vi.mocked(update.resolveUpdateInstallKind).mockResolvedValue(installKind);
      mocks.readPackageVersion.mockResolvedValue(installedVersion);
      vi.mocked(update.readConfigFileSnapshot).mockResolvedValue({
        ...f.baseSnapshot,
        config: { update: { channel: "dev" } },
      });

      await update.invokeUpdateCli({
        dryRun: true,
        json: true,
        restart: false,
        channel: "dev",
        acceptCapabilities: true,
      });

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
      const output = lastWriteJsonCall() as { runId: string };
      expect(update.listUpdateRuns()).toMatchObject([
        {
          runId: output.runId,
          trigger: "cli",
          phase: "finished",
          status: "skipped",
          reason: "dry-run",
        },
      ]);
      await update.invokeUpdateCli({ dryRun: true, restart: false });
      expect(getLogOutput()).toContain(`Current version: ${installedVersion ?? VERSION}`);
      expect(getLogOutput()).toContain("Target version: unresolved");
      expectNoSideEffects(
        cleanupStaleManagedServiceUpdateHandoffs,
        update.updateGitCheckout,
        update.replaceConfigFile,
        update.runDaemonInstall,
        update.runDaemonRestart,
        mocks.syncPluginsForUpdateChannel,
        mocks.updateNpmInstalledPlugins,
      );
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

  it.each(["progress initialization", "triage preparation"] as const)(
    "finishes the admitted run when %s fails before update execution",
    async (boundary) => {
      const { closeOpenClawStateDatabaseByPath } =
        await import("../state/openclaw-state-db-cache.js");
      const stateDir = f.tempDirs.make("openclaw-update-run-initialization-");
      f.initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
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
        const reported = await update
          .updateCommand({ yes: true, json: true })
          .catch((error: unknown) => error);
        const runs = update.listUpdateRuns();
        if (boundary === "progress initialization") {
          expect(reported).toEqual(new update.ExitError(1));
          expect(lastWriteJsonCall()).toMatchObject({
            status: "error",
            reason: "update-failed",
            runId: runs[0]?.runId,
            reportPath: expect.any(String),
          });
          expect(JSON.stringify(lastWriteJsonCall())).toContain(failure.message);
        } else {
          update.expectUpdateFailureReport(reported, failure, lastWriteJsonCall(), runs[0]?.runId);
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
        update.replaceConfigFile,
        update.updateGitCheckout,
        update.runDaemonInstall,
        update.runDaemonRestart,
        mocks.serviceStop,
        mocks.serviceStart,
        mocks.serviceRestart,
        update.doctorCommand,
        mocks.syncPluginsForUpdateChannel,
        mocks.updateNpmInstalledPlugins,
        mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(freshRestartCalls()).toHaveLength(0);
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

  it("leaves restored-generation completion with the helper across updateCommand unwind", async () => {
    const postUpdate = await import("./update-cli/update-command-post-update.js");
    const { UpdateCommandFailure } = await import("./update-cli/update-command-result.js");
    const { finishUpdateRun } = await import("../infra/update-run-ledger.js");
    const result = update.makeOkUpdateResult({
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
    f.mockOwnedGitService();
    update.mockGitUpdateAfterMutation(update.makeOkUpdateResult({ root: process.cwd() }));

    await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: "1" }, async () => {
      await expect(update.updateCommand({ yes: true, json: true })).rejects.toEqual(
        new update.ExitError(1),
      );

      expect(postUpdate.finishUpdate).toHaveBeenCalledOnce();
      const run = expectDefined(update.listUpdateRuns({ limit: 1 })[0], "helper-owned update run");
      expect(run).toMatchObject({ status: "running", after: { version: "2026.9.1" } });
      // Native recovery finishes after the CLI exits; the ledger must still accept its outcome.
      finishUpdateRun(run.runId, { status: "rolled-back", reason: result.reason });
      expect(update.getUpdateRun(run.runId)).toMatchObject({
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
    f.mockOwnedGitService();
    update.mockGitUpdateAfterMutation(update.makeOkUpdateResult({ root: process.cwd() }));

    await expect(update.updateCommand({ yes: true, json: true })).rejects.toEqual(
      new update.ExitError(1),
    );

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
      vi.spyOn(progressReads, "getUpdateRunForProgressAsync").mockImplementation((...args) => {
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
        mocks.stateSchemaVersions.getMockImplementation(),
        "schema inspection",
      );
      let observedActivation = false;
      mocks.stateSchemaVersions.mockImplementation(async (options) => {
        const versions = await inspectSchemas(options);
        if (mocks.serviceStop.mock.calls.length > 0 && !observedActivation) {
          // The real onActivation callback has run, but schema inspection has not
          // yet authorized this process to reopen the candidate's ledger.
          const progress = expectDefined(
            vi.mocked(update.updateGitCheckout).mock.calls[0]?.[0]?.opts.progress,
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
      f.mockOwnedGitService();
      update.mockGitUpdateAfterMutation(
        update.makeOkUpdateResult({
          root: process.cwd(),
          before: { version: "0.9.0" },
          after: { version: VERSION },
        }),
      );
      // Candidate admission precedes the intentionally absent post-core handoff CLI.
      vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
        path.join(process.cwd(), "dist", "index.js"),
      );
      f.mockCurrentProcessFreshDoctor();
      f.mockGatewayHealth(VERSION, "updated-gateway");
      mocks.serviceLoaded.mockResolvedValue(true);
      vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValue(
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
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        async (...args) => {
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
        },
      );
      const writeStep = stepWrites.recordUpdateRunStepAsync;
      vi.spyOn(stepWrites, "recordUpdateRunStepAsync").mockImplementation((...args) => {
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
      const pending = update.updateCommand({ yes: true, json });
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
        expect(update.runDaemonRestart).not.toHaveBeenCalled();
        const runId = expectDefined(receiptRunId, "buffered receipt run");
        expect(workerReply).toMatchObject({ kind: "recorded", record: { runId } });
        expect(update.getUpdateRun(runId)).toMatchObject({
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
          expect(update.runDaemonRestart).not.toHaveBeenCalled();
          expect(mocks.serviceRestart).not.toHaveBeenCalled();
          expect(mocks.serviceStart).not.toHaveBeenCalled();
          const failed = expectDefined(update.getUpdateRun(runId), "uncertain receipt history");
          expect(failed.status).not.toBe("succeeded");
          expect(failed.steps).toContainEqual(
            expect.objectContaining({ step: "core migrations", status: "completed" }),
          );
          expect(update.defaultRuntime.writeJson).not.toHaveBeenCalledWith(
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
        expect(update.runDaemonRestart).not.toHaveBeenCalled();
        const run = expectDefined(update.listUpdateRuns({ limit: 1 })[0], "admitted update run");
        expect(mocks.serviceStop, getErrorOutput()).toHaveBeenCalledOnce();
        expect(run, getErrorOutput()).toMatchObject({
          trigger: "cli",
          status: "succeeded",
          phase: "finished",
          verification: { serviceRunning: true, runningVersion: VERSION },
        });
        const phases = [
          "requested",
          "staging",
          "validating",
          "activating",
          "restarting",
          "verifying",
        ];
        expect(
          run.steps.filter((step) => phases.includes(step.step)).map((step) => step.step),
        ).toEqual(phases);
        expect(heldReads.length).toBeGreaterThan(0);
        expect(readSignals.every((signal) => signal.aborted)).toBe(true);
        const output = getLogOutput();
        expect(output.split("\n").filter((line) => line.startsWith("Phase:"))).toEqual(
          [...phases, "finished"].map((phase) => `Phase: ${phase}`),
        );
        expect(output.indexOf("OpenClaw updated")).toBeGreaterThan(
          output.indexOf("Phase: finished"),
        );
      } finally {
        release.resolve();
        await settled;
        for (const releaseRead of releaseReads) {
          releaseRead();
        }
        await Promise.allSettled(heldReads);
      }
    },
  );

  it.each([
    { name: "update channel", run: () => update.invokeUpdateCli({ channel: "" }) },
    { name: "finalization channel", run: () => update.updateFinalizeCommand({ channel: "" }) },
  ])("rejects an explicitly empty $name before mutation", async ({ run }) => {
    const runsBefore = update.listUpdateRuns();
    await run();

    expect(update.defaultRuntime.error).toHaveBeenCalledWith(
      '--channel must be "stable", "extended-stable", "beta", or "dev" (got "")',
    );
    expect(update.defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(update.listUpdateRuns()).toEqual(runsBefore);
    expectNoSideEffects(
      cleanupStaleManagedServiceUpdateHandoffs,
      update.replaceConfigFile,
      update.updateGitCheckout,
      update.doctorCommand,
      mocks.syncPluginsForUpdateChannel,
    );
  });
});
