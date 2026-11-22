import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";
import { ExpectedCliError } from "./expected-cli-error.js";
import {
  expectNoSideEffects,
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
