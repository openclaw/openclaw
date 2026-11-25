import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { VERSION } from "../version.js";
import { ExpectedCliError } from "./expected-cli-error.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import {
  expectNoSideEffects,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import { createGitUpdateAfterMutationFixture } from "./update-cli-invocation.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import * as postUpdateMaintenance from "./update-cli/update-command-post-update-maintenance.js";

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

  it("waits for deferred activation receipts before finalizing a package-to-Git switch", async ({
    signal,
  }) => {
    const root = await f.mockPackageInstallAtCaseDir();
    f.mockOwnedGitService(root);
    const gitRoot = update.updateCliShared.resolveGitInstallDir();
    await fs.mkdir(path.join(gitRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(gitRoot, "package.json"), '{"name":"openclaw","version":"1.0.0"}');
    const step = "fixture-activation-receipt";
    const fixture = createGitUpdateAfterMutationFixture();
    vi.mocked(update.updateGitRelease).mockImplementationOnce(async (args) => {
      const result = await fixture.run(args);
      await args.opts.progress?.onStepComplete?.({
        name: step,
        command: "build candidate",
        durationMs: 1,
        exitCode: 0,
        index: 0,
        total: 1,
      });
      return result;
    });
    const entered = createDeferred();
    const release = createDeferred();
    const lostReply = new SqliteWorkerError("activation receipt reply lost", "outcome-unknown");
    let receiptWrites = 0;
    using _ = sqliteWorkerOwnerProbe.command(stateWorker, async (command, options, scope) => {
      const reply = await scope.execute(command, options);
      if (
        command.type === "updateRuns.recordStep" &&
        command.input &&
        "step" in command.input &&
        command.input.step.step === step
      ) {
        receiptWrites++;
        entered.resolve();
        await release.promise;
        throw lostReply;
      }
      return reply;
    });
    const prepareService = vi.spyOn(postUpdateMaintenance, "preparePostUpdateService");
    const pending = withConsoleLogsRoutedToStderrForJson(["openclaw", "update", "--json"], () =>
      update.invokeUpdateCli({ yes: true, channel: "dev", json: true }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "CLI completed without settling its deferred receipt",
        ),
        signal,
      );
      expect(update.listUpdateRuns()[0]?.steps.filter((entry) => entry.step === step)).toEqual([
        expect.objectContaining({ status: "completed" }),
      ]);
      expect(prepareService).not.toHaveBeenCalled();
      expect(lastWriteJsonCall()).toBeUndefined();
      release.resolve();
      await pending;
      expect(update.defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect(prepareService).not.toHaveBeenCalled();
      expect(receiptWrites).toBe(1);
      expect(update.listUpdateRuns()[0]?.status).not.toBe("succeeded");
      expect(lastWriteJsonCall()).not.toMatchObject({ status: "ok" });
    } finally {
      release.resolve();
      await pending;
    }
  });

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
      const outputText = stripAnsi(getLogOutput());
      expect(outputText).toContain(`Current version: ${installedVersion ?? VERSION}`);
      expect(outputText).toContain("Target version: unresolved");
      expectNoMutation(
        update.runDaemonInstall,
        update.runDaemonRestart,
        mocks.updateNpmInstalledPlugins,
      );
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

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
