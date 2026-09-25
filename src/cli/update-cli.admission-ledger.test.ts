import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
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
    runUpdateCliScenario,
    setupNonInteractiveDowngrade,
    tempDirs,
  } = createUpdateCliFixture();

  it.each([
    {
      name: "preview mode",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        serviceLoaded.mockResolvedValue(true);
        mockOwnedGitService();
        await updateCommand({ dryRun: true, channel: "beta" });
      },
      assert: () => {
        expectNoSideEffects(
          cleanupStaleManagedServiceUpdateHandoffs,
          replaceConfigFile,
          updateGitCheckout,
          runDaemonInstall,
          runDaemonRestart,
          launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
        );
        expect(freshRestartCalls()).toHaveLength(0);

        const logs = getLogOutput();
        expect(logs).toContain("Update dry-run");
        expect(logs).toContain("No changes were applied.");
      },
    },
    {
      name: "downgrade bypass",
      run: async () => {
        await setupNonInteractiveDowngrade();
        vi.mocked(defaultRuntime.exit).mockClear();
        await updateCommand({ dryRun: true });
      },
      assert: () => {
        expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
        expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
        expect(updateGitCheckout).not.toHaveBeenCalled();
        expect(
          launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
        ).not.toHaveBeenCalled();
      },
    },
  ] as const)("updateCommand dry-run behavior: $name", runUpdateCliScenario);

  it.each([
    { name: "text", options: { dryRun: true, channel: "beta" } },
    { name: "JSON", options: { dryRun: true, json: true, channel: "beta" } },
  ])("reads config without recording observations during a $name dry run", async ({ options }) => {
    await updateCommand(options);

    expect(readConfigFileSnapshot).toHaveBeenCalledWith({
      skipPluginValidation: true,
      observe: false,
    });
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
  });

  it.each([
    { installKind: "git", installedVersion: "2026.9.3" },
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
        expectUpdateFailureReport(reported, failure, lastWriteJsonCall(), runs[0]?.runId);
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
    vi.spyOn(postUpdate, "finishUpdate").mockRejectedValueOnce(new UpdateCommandFailure(result));
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

  it.each([false, true])(
    "records ordered update phases across service stop, restart, and verified health (json=%s)",
    async (json) => {
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
          expectDefined(
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
      try {
        await updateCommand({ yes: true, json });
      } catch (error) {
        throw new Error(`${getErrorOutput()}\n${JSON.stringify(lastWriteJsonCall())}`, {
          cause: error,
        });
      }
      expect(observedActivation).toBe(true);
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
      if (!json) {
        expect(getLogOutput()).toContain("Phase: activating");
        expect(getLogOutput()).toContain("Phase: verifying");
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
