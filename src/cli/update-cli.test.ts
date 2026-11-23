import fs from "node:fs/promises";
import path from "node:path";
import { CANCEL_SYMBOL } from "@clack/core";
import { Command } from "commander";
import { afterAll, aroundEach, describe, expect, it, vi } from "vitest";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { readOwedUpdateSteps } from "../infra/update-run-ledger.js";
import * as systemPackageOwnership from "../infra/update-system-package-ownership.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import * as release from "../update/cli.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import * as check from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const {
  defaultRuntime: runtime,
  runCommandWithTimeout: runCommand,
  updateCommand: runUpdate,
  updateGitRelease: gitUpdate,
} = cli;

describe("update-cli", () => {
  // Reuse native reader imports; each request still captures fresh state and admission.
  const inspectionWorkers = createSqliteReadOnlyWorkerScope();
  aroundEach((runTest) => inspectionWorkers.run(runTest));
  afterAll(() => inspectionWorkers.close());
  const {
    createCaseDir,
    mockPackageInstallAtCaseDir,
    setTty,
    setupNonInteractiveDowngrade,
    tempDirs,
  } = createUpdateCliFixture();

  it("disarms legacy launchd updater jobs before refusing mutating updates in Nix mode", async () => {
    await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
      await expect(runUpdate({ yes: true })).rejects.toThrow("OPENCLAW_NIX_MODE=1");
    });

    expect(
      mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    ).toHaveBeenCalledOnce();
    check.expectNoSideEffects(gitUpdate, cli.replaceConfigFile, mocks.updateNpmInstalledPlugins);
  });

  it("delegates mutating updates when an external supervisor owns gateway lifecycle", async () => {
    await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
      await cli.invokeUpdateCli({ yes: true });
    });

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runtimeCapture.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Use the external supervisor's update workflow so it can stop the gateway",
      ),
    );
    check.expectNoSideEffects(
      gitUpdate,
      cli.readConfigFileSnapshot,
      cli.replaceConfigFile,
      mocks.updateNpmInstalledPlugins,
    );
  });

  it("logs friendly hint with manual refresh command when completion cache write times out", async () => {
    const root = createCaseDir("openclaw-completion-timeout-msg");
    mocks.pathExists.mockResolvedValue(true);
    vi.mocked(runCommand).mockResolvedValueOnce(
      commandResult({ code: 124, killed: true, termination: "timeout" }),
    );
    vi.mocked(mocks.runtimeCapture.log).mockClear();

    await cli.updateCliShared.tryWriteCompletionCache(root, false);

    const logOutput = check.getLogOutput();
    expect(logOutput).toContain("timed out after 30s");
    expect(logOutput).toContain("openclaw completion --write-state");
  });

  it.each([false, true])(
    "renders update status before invalid config warnings with json=%s",
    async (json) => {
      const sourceConfig = {
        update: { channel: "dev" as const },
        meta: { lastTouchedVersion: "2026.7.35", lastTouchedAt: "2026-07-31T12:00:00.000Z" },
      };
      vi.mocked(cli.readSourceConfigBestEffort).mockResolvedValue(sourceConfig);

      await cli.updateStatusCommand({ json });

      const issue = 'meta: Unrecognized key: "lastTouchedAt"';
      if (json) {
        expect(
          check.requireValue(check.lastWriteJsonCall(), "update status JSON output"),
        ).toMatchObject({
          channel: { value: "dev", config: "dev" },
          configWarnings: expect.arrayContaining([
            expect.stringContaining(issue),
            expect.stringContaining("openclaw doctor --fix"),
          ]),
        });
      } else {
        const output = check.getLogOutput();
        expect(output).toContain("OpenClaw update status");
        expect(output).toContain(`Warning: ${issue}`);
        expect(output).toContain("openclaw doctor --fix");
        expect(output.indexOf(`Warning: ${issue}`)).toBeGreaterThan(output.indexOf("Channel"));
      }
      expect(cli.checkUpdateStatus).toHaveBeenCalledWith(
        expect.objectContaining({ useDetachedDevUpstream: true }),
      );
      expect(cli.readSourceConfigBestEffort).toHaveBeenCalledOnce();
      expect(cli.readConfigFileSnapshot).not.toHaveBeenCalled();
      expect(sourceConfig.meta.lastTouchedAt).toBe("2026-07-31T12:00:00.000Z");
    },
  );

  it("routes an explicit beta request from Git through the package switch", async () => {
    await mockPackageInstallAtCaseDir();
    vi.mocked(cli.resolveUpdateInstallKind).mockResolvedValue("git");
    vi.mocked(cli.resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "git" });

    await runUpdate({ yes: true, channel: "beta" });

    check.expectPackageInstallSpec("openclaw@9999.0.0");
    expect(cli.replaceConfigFile).toHaveBeenCalledTimes(1);
    expect(check.lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("beta");
  });

  describe("a switch from a Git checkout to a package install", () => {
    /** The checkout's wrapper, first on PATH, as `install.sh` and `install.ps1` write it. */
    const switchFromGitCheckout = async () => {
      const root = await mockPackageInstallAtCaseDir();
      vi.mocked(cli.resolveUpdateInstallKind).mockResolvedValue("git");
      vi.mocked(cli.resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "git" });
      const bin = tempDirs.make("openclaw-git-wrapper-bin-");
      const windows = process.platform === "win32";
      const wrapper = path.join(bin, windows ? "openclaw.cmd" : "openclaw");
      const entry = path.join(root, "dist", "entry.js");
      await fs.writeFile(
        wrapper,
        windows
          ? `@echo off\r\nnode "${entry}" %*\r\n`
          : `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${entry.replaceAll(" ", "\\ ")} "$@"\n`,
        { mode: 0o755 },
      );
      const original = await fs.readFile(wrapper, "utf8");
      return {
        wrapper,
        wrapperUnchanged: async () => (await fs.readFile(wrapper, "utf8")) === original,
        installedVersion: async () =>
          JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version,
        update: (restart: boolean) =>
          withEnvAsync({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }, () =>
            runUpdate({ yes: true, channel: "beta", restart }),
          ),
      };
    };

    it.each([
      { gateway: "--no-restart", restart: false },
      { gateway: "no Gateway service", restart: true },
    ])(
      "keeps the package and warns about the old wrapper it cannot retire ($gateway)",
      async ({ restart }) => {
        const { wrapper, wrapperUnchanged, installedVersion, update } =
          await switchFromGitCheckout();
        const unlink = fs.unlink;
        vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
          if (file === wrapper) {
            throw new Error("EACCES: permission denied, unlink");
          }
          await unlink(file);
        });

        await update(restart);

        const run = cli.listUpdateRuns({ limit: 1 })[0];
        expect(run, check.getErrorOutput()).toMatchObject({ status: "succeeded" });
        expect(run?.steps.map((step) => step.step)).not.toContain("package rollback");
        expect(await installedVersion()).toBe("9999.0.0");
        expect(await wrapperUnchanged()).toBe(true);
        const warning = `Could not finish removing the previous Git checkout's openclaw wrapper: Could not retire ${wrapper}: Error: EACCES: permission denied, unlink. The package install is kept. If \`openclaw\` still starts the old checkout, remove its wrapper from PATH.`;
        const report = check.getLogOutput();
        expect(report).toContain("OpenClaw updated to 9999.0.0");
        expect(report).toContain(`Warning: ${warning}`);
        // The warning stays in update history. No later command can retry it, so it is not owed.
        expect(run?.steps).toContainEqual(
          expect.objectContaining({ step: "warning:git-wrapper-retirement", detail: warning }),
        );
        expect(readOwedUpdateSteps()).toEqual([]);
      },
    );

    it("still fails and restores the previous install when a system package owns the old wrapper", async () => {
      const { wrapper, wrapperUnchanged, installedVersion, update } = await switchFromGitCheckout();
      const inspect = systemPackageOwnership.createSystemPackageOwnershipInspection;
      const refused = vi.fn();
      vi.spyOn(systemPackageOwnership, "createSystemPackageOwnershipInspection").mockImplementation(
        (...args) => ({
          ...inspect(...args),
          assertEntryUnowned: async (file) => {
            if (file === wrapper) {
              refused();
              throw new systemPackageOwnership.SystemPackageOwnershipError("owned-install");
            }
          },
        }),
      );

      await expect(update(false)).rejects.toEqual(new cli.ExitError(1));

      expect(refused).toHaveBeenCalledOnce();
      const run = cli.listUpdateRuns({ limit: 1 })[0];
      expect(run, check.getErrorOutput()).toMatchObject({ status: "failed" });
      // The failed finalization restores the previous package and settles its backup.
      expect(run?.steps.map((step) => step.step)).toEqual(
        expect.arrayContaining(["package rollback", "package-backup-retention"]),
      );
      expect(await installedVersion()).toBe("1.0.0");
      expect(await wrapperUnchanged()).toBe(true);
      expect(readOwedUpdateSteps()).toEqual([]);
    });
  });

  it.each([
    {
      name: "update status command invalid timeout",
      argv: ["update", "status", "--timeout", "invalid"],
      requireTty: false,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update repair invalid timeout",
      argv: ["update", "repair", "--timeout", "invalid"],
      requireTty: false,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update wizard requires a TTY",
      argv: ["update", "wizard"],
      requireTty: false,
      expectedError:
        "Update wizard requires a TTY. Use `openclaw update --channel <stable|extended-stable|beta|dev>` instead.",
    },
  ] as const)(
    "validates update command invocation errors: $name",
    async ({ argv, requireTty, expectedError }) => {
      setTty(requireTty);
      vi.mocked(runtime.error).mockClear();
      vi.mocked(runtime.exit).mockClear();
      const runsBefore = cli.listUpdateRuns();
      const program = new Command();
      cli.registerUpdateCli(program);

      await program.parseAsync([...argv], { from: "user" });

      expect(vi.mocked(runtime.error).mock.calls).toEqual([[expectedError]]);
      expect(vi.mocked(runtime.exit).mock.calls).toEqual([[1]]);
      expect(cli.listUpdateRuns()).toEqual(runsBefore);
      check.expectNoSideEffects(
        cli.readConfigFileSnapshot,
        cli.runDaemonInstall,
        cli.runDaemonRestart,
      );
    },
  );

  it("routes an invalid wizard timeout to the outer JSON error owner", async () => {
    setTty(true);
    const previousArgv = process.argv;
    process.argv = ["node", "openclaw", "update", "--json", "wizard", "--timeout", "invalid"];
    const program = new Command();
    cli.registerUpdateCli(program);
    const runsBefore = cli.listUpdateRuns();
    try {
      await expect(
        withConsoleLogsRoutedToStderrForJson(process.argv, () => program.parseAsync(process.argv)),
      ).rejects.toThrow("--timeout must be a positive integer (seconds)");
    } finally {
      process.argv = previousArgv;
    }

    expect(cli.listUpdateRuns()).toEqual(runsBefore);
    check.expectNoSideEffects(
      runtime.error,
      runtime.exit,
      runtime.writeJson,
      cli.readConfigFileSnapshot,
      cli.runDaemonInstall,
      cli.runDaemonRestart,
    );
  });

  it.each([false, true])("passes downgrade consent to the release owner (yes=%s)", async (yes) => {
    await setupNonInteractiveDowngrade();
    const runsBefore = cli.listUpdateRuns();
    const runRelease = vi.spyOn(release, "runReleaseUpdateCli").mockResolvedValue(undefined);
    await runUpdate({ yes });
    expect(runRelease).toHaveBeenCalledWith(expect.objectContaining({ yes }));
    expect(cli.listUpdateRuns()).toEqual(runsBefore);
    check.expectNoSideEffects(runtime.exit, gitUpdate, cli.runDaemonInstall, cli.runDaemonRestart);
  });

  it.each(["channel", "restart"])(
    "cancels the wizard at %s without inspecting update freshness",
    async (prompt) => {
      setTty(true);
      if (prompt === "channel") {
        mocks.select.mockResolvedValue(CANCEL_SYMBOL);
      } else {
        mocks.confirm.mockResolvedValue(CANCEL_SYMBOL);
      }
      vi.mocked(cli.checkUpdateStatus).mockRejectedValue(
        new Error("Freshness inspection unavailable"),
      );

      await cli.updateWizardCommand();

      expect(mocks.select).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Update channel" }),
      );
      expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Update cancelled."));
      check.expectNoSideEffects(gitUpdate, mocks.sourceRuntimeCompletion);
    },
  );

  it("update wizard forwards explicit consent before the subcommand", async () => {
    await mockPackageInstallAtCaseDir();
    setTty(true);
    mocks.select.mockResolvedValue("beta");
    mocks.confirm.mockResolvedValueOnce(true);
    const runRelease = vi.spyOn(release, "runReleaseUpdateCli").mockResolvedValue(undefined);
    const program = new Command();
    program.exitOverride();
    cli.registerUpdateCli(program);

    await program.parseAsync(["node", "openclaw", "update", "--accept-capabilities", "wizard"]);

    expect(runRelease).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "beta", acceptCapabilities: true }),
    );
    expect(runtime.exit).not.toHaveBeenCalledWith(1);
  });
});
