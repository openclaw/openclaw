import { describe, expect, it, vi } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import { ExpectedCliError } from "./expected-cli-error.js";
import {
  expectNoSideEffects,
  freshRestartCalls,
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
  function expectNoMutation(...effects: unknown[]) {
    expectNoSideEffects(
      update.replaceConfigFile,
      update.updateGitRelease,
      mocks.syncPluginsForUpdateChannel,
      ...effects,
    );
  }

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
      expectNoMutation(
        update.runDaemonInstall,
        update.runDaemonRestart,
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

      expectNoMutation(
        update.runDaemonInstall,
        update.runDaemonRestart,
        mocks.serviceStop,
        mocks.serviceStart,
        mocks.serviceRestart,
        update.doctorCommand,
        mocks.updateNpmInstalledPlugins,
        mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(freshRestartCalls()).toHaveLength(0);
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

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

  it.each([
    { name: "update channel", run: () => update.invokeUpdateCli({ channel: "" }) },
    { name: "finalization channel", run: () => update.updateFinalizeCommand({ channel: "" }) },
  ])("rejects an explicitly empty $name before mutation", async ({ name, run }) => {
    const runsBefore = update.listUpdateRuns();
    const message = '--channel must be "stable", "extended-stable", "beta", or "dev" (got "")';
    if (name === "finalization channel") {
      const failure = await run().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ExpectedCliError);
      expect(failure).toMatchObject({ humanOutput: message, machineOutput: message });
      expectNoSideEffects(update.defaultRuntime.error, update.defaultRuntime.exit);
    } else {
      await run();
      expect(update.defaultRuntime.error).toHaveBeenCalledWith(message);
      expect(update.defaultRuntime.exit).toHaveBeenCalledWith(1);
    }
    expect(update.listUpdateRuns()).toEqual(runsBefore);
    expectNoMutation(update.doctorCommand);
  });
});
