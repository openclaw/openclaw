import fs from "node:fs/promises";
import path from "node:path";
import { CANCEL_SYMBOL } from "@clack/core";
import { Command } from "commander";
import { afterAll, aroundEach, describe, expect, it, vi } from "vitest";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { applyDevUpdateTargetEnv } from "../infra/update-dev-target.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import * as check from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const {
  defaultRuntime: runtime,
  runCommandWithTimeout: runCommand,
  updateCommand: runUpdate,
  updateGitCheckout: gitUpdate,
} = cli;
const { packageInstallCommandCall: packageInstall, freshRestartCalls: restarts } = check;

describe("update-cli", () => {
  // Reuse native reader imports; each request still captures fresh state and admission.
  const inspectionWorkers = createSqliteReadOnlyWorkerScope();
  aroundEach((runTest) => inspectionWorkers.run(runTest));
  afterAll(() => inspectionWorkers.close());
  const nodeExecutable = resolveTestNodeExecPath();
  const {
    configSnapshot,
    createCaseDir,
    mockCurrentProcessFreshDoctor,
    mockFileBackedPathExists,
    mockNpmGlobalCommands,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    setTty,
    setupNonInteractiveDowngrade,
    setupInstalledPackageAtNodeModules,
    runRestartFallbackScenario,
    tempDirs,
    mockGatewayHealth,
    mockGatewayInstallFailure,
    mockRunningManagedGateway,
    primeServiceCommand,
    profileStateDir,
    setupNpmUpdatedRootRefresh,
    setupUpdatedRootRefresh,
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

  it("keeps update completion refresh best-effort when profile install fails", async () => {
    setTty(true);
    mocks.checkShellCompletionStatus.mockResolvedValue({
      shell: "zsh",
      profileInstalled: true,
      cacheExists: true,
      cachePath: "/tmp/openclaw-completion.zsh",
      usesSlowPattern: true,
    });
    mocks.installCompletion.mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await runUpdate({ yes: true, restart: false });

    const logOutput = check.getLogOutput();
    expect(logOutput).toContain("Shell completion refresh failed: EACCES: permission denied");
    expect(runtime.exit).not.toHaveBeenCalledWith(1);
  });

  it("prompts for optional shell completion setup without --yes", async () => {
    setTty(true);
    mocks.confirm.mockResolvedValue(true);

    await runUpdate({ yes: false, restart: false });

    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.installCompletion).toHaveBeenCalledWith("zsh", false, "openclaw");
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

  it.each([
    {
      name: "one-off tag with stored dev",
      installKind: "package",
      storedChannel: "dev",
      tag: "latest",
      channel: undefined,
    },
    {
      name: "explicit beta from Git",
      installKind: "git",
      storedChannel: undefined,
      tag: undefined,
      channel: "beta",
    },
  ] as const)(
    "routes package updates for $name",
    async ({ installKind, storedChannel, tag, channel }) => {
      await mockPackageInstallAtCaseDir();
      if (installKind === "git") {
        vi.mocked(cli.resolveUpdateInstallKind).mockResolvedValue("git");
        vi.mocked(cli.resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "git" });
      }
      if (storedChannel) {
        vi.mocked(cli.readConfigFileSnapshot).mockResolvedValue(
          configSnapshot({ update: { channel: storedChannel } }),
        );
      }
      await runUpdate({ yes: true, tag, channel });
      check.expectPackageInstallSpec("openclaw@9999.0.0");
      if (channel) {
        expect(cli.replaceConfigFile).toHaveBeenCalledTimes(1);
        expect(check.lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe(channel);
      }
    },
  );

  it("installs the verified exact package and persists an explicit extended-stable channel", async () => {
    await mockPackageInstallAtCaseDir();
    mocks.readPackageVersion.mockResolvedValueOnce("1.0.0").mockResolvedValue("2026.6.33");

    await runUpdate({ channel: "extended-stable", yes: true, restart: false });

    expect(cli.resolveExtendedStablePackage).toHaveBeenCalledWith({
      installKind: "package",
      timeoutMs: undefined,
      packageName: "openclaw",
    });
    check.expectPackageInstallSpec("openclaw@2026.6.33");
    expect(check.lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("extended-stable");
    expect(check.syncPluginCall()?.channel).toBe("extended-stable");
    expect(check.syncPluginCall()?.coreVersion).toBe("2026.6.33");
    expect(check.lastNpmPluginUpdateCall()?.updateChannel).toBe("extended-stable");
    expect(check.lastNpmPluginUpdateCall()?.coreVersion).toBe("2026.6.33");
  });

  it("rejects --tag for a stored extended-stable channel", async () => {
    await mockPackageInstallAtCaseDir();
    vi.mocked(cli.readConfigFileSnapshot).mockResolvedValue(
      configSnapshot({ update: { channel: "extended-stable" } }),
    );

    await expect(runUpdate({ tag: "latest", yes: true })).rejects.toEqual(new cli.ExitError(1));

    expect(cli.resolveExtendedStablePackage).not.toHaveBeenCalled();
    expect(packageInstall()?.[0]).toBeUndefined();
    check.expectNoSideEffects(
      cli.replaceConfigFile,
      mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects extended-stable Git updates before handoff, conversion, or config mutation", async () => {
    await expect(runUpdate({ channel: "extended-stable", yes: true })).rejects.toEqual(
      new cli.ExitError(1),
    );

    check.expectNoSideEffects(
      cli.resolveExtendedStablePackage,
      gitUpdate,
      cli.replaceConfigFile,
      mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(
      check.commandCalls().every(([argv]) => argv[0] === "git" && argv.includes("rev-parse")),
    ).toBe(true);
    expect(runtime.exit).not.toHaveBeenCalled();
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
        cleanupStaleManagedServiceUpdateHandoffs,
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
      cleanupStaleManagedServiceUpdateHandoffs,
      cli.runDaemonInstall,
      cli.runDaemonRestart,
    );
  });

  it.each([
    {
      name: "requires confirmation without --yes",
      options: {},
      shouldExit: true,
      shouldRunPackageUpdate: false,
    },
    {
      name: "allows downgrade with --yes",
      options: { yes: true },
      shouldExit: false,
      shouldRunPackageUpdate: true,
    },
  ])("$name in non-interactive mode", async ({ options, shouldExit, shouldRunPackageUpdate }) => {
    const root = await setupNonInteractiveDowngrade();
    const runsBefore = cli.listUpdateRuns();
    if (shouldRunPackageUpdate) {
      mockCurrentProcessFreshDoctor({ packageRoot: root, postCoreResumeAttempt: false });
    }
    if (shouldExit) {
      await expect(runUpdate(options)).rejects.toEqual(new cli.ExitError(1));
      expect(cli.listUpdateRuns()).toEqual(runsBefore);
      await expect(fs.stat(`${profileStateDir()}.update-captures`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      check.expectNoSideEffects(
        cli.replaceConfigFile,
        cli.mutateConfigFileWithRetry,
        cli.runDaemonInstall,
        cli.runDaemonRestart,
      );
    } else {
      await runUpdate(options);
    }
    expect(check.getLogOutput().includes("Downgrade confirmation required.")).toBe(shouldExit);
    check.expectNoSideEffects(runtime.exit, gitUpdate);
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.some(
          (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
        ),
    ).toBe(shouldRunPackageUpdate);
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
    const root = await fs.realpath(tempDirs.make("openclaw-update-wizard-"));
    const tempDir = path.join(root, "openclaw");
    const nodeModules = path.join(root, "prefix", "lib", "node_modules");
    const packageRoot = path.join(nodeModules, "openclaw");
    const sha = "a".repeat(40);
    await writeOpenClawPackageFixture(packageRoot, "2026.4.10", { inventory: true });
    mockPackageInstallStatus(packageRoot);
    mockFileBackedPathExists();
    mockNpmGlobalCommands(
      nodeModules,
      async (argv) => {
        if (argv[0] === "git" && argv[1] === "clone") {
          const stagingDir = check.requireValue(argv.at(-1), "clone destination");
          await writeOpenClawPackageFixture(stagingDir, "2026.8.1", { git: true });
          return commandResult();
        }
        return undefined;
      },
      tempDir,
    );
    vi.spyOn(cli.updateCliShared, "tryWriteCompletionCache").mockResolvedValueOnce("completed");
    await withEnvAsync({ OPENCLAW_GIT_DIR: tempDir }, async () => {
      setTty(true);
      mocks.select.mockResolvedValue("dev");
      mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      vi.mocked(gitUpdate).mockImplementation(async ({ opts: options }) => {
        await writeOpenClawPackageFixture(tempDir, "2026.8.1", { git: true, builtSha: sha });
        await options.prepareGitExposure?.(tempDir, sha, undefined);
        await options.validateCandidate(tempDir);
        await check.requireValue(options.beforeGitMutation, "Git mutation admission")({});
        return cli.makeOkUpdateResult({
          root: tempDir,
          after: { sha, version: "2026.8.1" },
        });
      });
      const runFixtureExec = check.requireValue(
        vi.mocked(cli.runExec).getMockImplementation(),
        "exec fixture",
      );
      vi.mocked(cli.runExec).mockImplementation((file, args, options) => {
        if (
          args.length === 3 &&
          args[0] === path.join(tempDir, "dist", "entry.js") &&
          args[1] === "update" &&
          args[2] === "--help"
        ) {
          return Promise.resolve({
            stdout: new Command("update").option("--accept-capabilities").helpInformation(),
            stderr: "",
          });
        }
        return runFixtureExec(file, args, options);
      });

      const program = new Command();
      program.exitOverride();
      cli.registerUpdateCli(program);
      await program.parseAsync(["node", "openclaw", "update", "--accept-capabilities", "wizard"]);

      expect(cli.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
      const call = vi.mocked(gitUpdate).mock.calls[0]?.[0];
      expect(call?.opts.channel).toBe("dev");
      await expect(fs.realpath(packageRoot)).resolves.toBe(tempDir);
      // Directory-observation helpers can also spawn while the update runs.
      const updateInvocations = mocks.spawn.mock.calls
        .map(([, args]) => args)
        .filter((args) => args[1] === "update");
      expect(updateInvocations).toEqual([
        [
          path.join(tempDir, "dist", "entry.js"),
          "update",
          "--no-restart",
          "--accept-capabilities",
          "--timeout",
          "1800",
        ],
      ]);
      check.expectNoSideEffects(mocks.syncPluginsForUpdateChannel, mocks.updateNpmInstalledPlugins);
      expect(runtime.exit).not.toHaveBeenCalledWith(1);
    });
  });

  it.each([
    {
      name: "versioned tracked target",
      env: applyDevUpdateTargetEnv(
        {},
        { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "frozen-sha" },
      ),
      expected: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "frozen-sha" },
    },
  ])("maps the internal dev target environment $name", async ({ env, expected }) => {
    await withEnvAsync(env, async () => {
      await runUpdate({ channel: "dev", yes: true, restart: false });
    });

    expect(vi.mocked(gitUpdate).mock.calls[0]?.[0]?.opts).toEqual(
      expect.objectContaining({ devTarget: expected }),
    );
  });

  it.each([cli.devTargetRefusalCases[4]])(
    "rejects a %s dev target before running the update",
    async (_name, value) => {
      const diagnostic =
        "Invalid internal OPENCLAW_UPDATE_DEV_TARGET_REF contract; expected a plain Git ref or a supported tracked-target encoding.";
      await withEnvAsync({ OPENCLAW_UPDATE_DEV_TARGET_REF: value }, async () => {
        const command = cli.invokeUpdateCli({
          json: true,
          yes: true,
          restart: false,
        });
        await expect(command).rejects.toEqual(new cli.ExitError(1));
      });

      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(diagnostic);
      expect(runtime.exit).not.toHaveBeenCalled();
      check.expectNoSideEffects(
        cli.runUpdateFailureTriage,
        cleanupStaleManagedServiceUpdateHandoffs,
        gitUpdate,
        cli.replaceConfigFile,
        cli.mutateConfigFileWithRetry,
        cli.runDaemonInstall,
        cli.runDaemonRestart,
        mocks.syncPluginsForUpdateChannel,
        mocks.updateNpmInstalledPlugins,
        mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      const runs = cli.listUpdateRuns();
      expect(runs).toHaveLength(1);
      expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          status: "error",
          reason: "invalid-dev-target",
          runId: runs[0]?.runId,
          failedStep: expect.objectContaining({
            name: "invalid-dev-target",
            exitCode: 1,
            stderrTail: diagnostic,
            failureFacts: [
              { check: "invalid-dev-target", code: "invalid-dev-target", message: diagnostic },
            ],
          }),
          run: expect.objectContaining({
            runId: runs[0]?.runId,
            status: "failed",
            phase: "finished",
            reason: "invalid-dev-target",
          }),
        }),
      );
      expect(runs[0]).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: "invalid-dev-target",
        origin: { nextAction: diagnostic },
      });
      expect(runs[0]?.steps).toContainEqual(
        expect.objectContaining({ step: "invalid-dev-target", status: "failed", exitCode: 1 }),
      );
    },
  );

  it.each(["error", "skipped"] as const)("explains edited files (%s)", async (status) => {
    vi.mocked(runtime.log).mockClear();
    vi.mocked(runtime.error).mockClear();
    vi.mocked(runtime.exit).mockClear();
    vi.mocked(gitUpdate).mockResolvedValue({
      status,
      mode: "git",
      reason: "dirty",
      steps: [],
      durationMs: 100,
    } satisfies UpdateRunResult);

    await expect(runUpdate({ channel: "dev" })).rejects.toEqual(new cli.ExitError(1));

    const logs = check.getLogOutput();
    expect(logs).toContain(`OpenClaw update ${status === "error" ? "failed" : "skipped"}: dirty.`);
    expect(logs).toContain(
      "Local changes prevented this update before installation. Your checkout was preserved.",
    );
    expect(logs).toContain("Commit your changes and retry, or run `openclaw triage` for help.");
    expect(cli.listUpdateRuns({ limit: 1 })[0]?.origin.nextAction).toContain(
      "Commit your changes and retry",
    );
    check.expectNoSideEffects(mocks.serviceStop, runtime.exit);
  });
  it("reports activation failure when the updated CLI entrypoint is missing", async () => {
    const root = await mockPackageInstallAtCaseDir();
    mockRunningManagedGateway([
      nodeExecutable,
      path.join(root, "dist", "index.js"),
      "gateway",
      "run",
    ]);
    vi.mocked(cli.resolveGatewayInstallEntrypoint).mockReset().mockResolvedValue(undefined);
    mocks.serviceLoaded.mockResolvedValue(true);
    vi.mocked(cli.runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));

    await expect(runUpdate({ yes: true })).rejects.toEqual(new cli.ExitError(1));

    check.expectNoSideEffects(cli.runDaemonInstall, mocks.serviceStart);
    expect(restarts().length).toBe(0);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("tries the updated install restart when package service refresh fails in JSON mode", async () => {
    const { updatedRoot, updatedEntrypoint } = setupNpmUpdatedRootRefresh();
    mocks.serviceLoaded.mockResolvedValue(true);
    primeServiceCommand([nodeExecutable, updatedEntrypoint, "gateway", "run"]);
    mockGatewayInstallFailure(updatedEntrypoint, "runtime warning");
    mockGatewayHealth("2026.4.24", "updated-gateway");

    await runUpdate({ yes: true, json: true });

    expect(check.gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
    const restartCall = check.gatewayCommandCall(updatedEntrypoint, "restart");
    expect(restartCall?.[0].slice(4)).toEqual([
      "--preserve-definition",
      "--json",
      "--update-executor",
      "run",
    ]);
    expect(restartCall?.[1].cwd).toBe(updatedRoot);
    expect(runtime.exit).not.toHaveBeenCalledWith(1);
    expect(check.getErrorOutput()).toContain(
      "SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: Error: launchctl bootstrap failed",
    );
  });

  it("warns without restarting a stale same-version service when installation reconciliation fails", async () => {
    const oldRoot = createCaseDir("openclaw-old-root");
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const oldEntrypoint = path.join(oldRoot, "dist", "entry.js");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    setupUpdatedRootRefresh({
      entrypoints: [oldEntrypoint, updatedEntrypoint],
      targetVersion: "2026.4.24",
      gatewayUpdateImpl: async () =>
        cli.makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.24" },
          after: { version: "2026.4.24" },
        }),
    });
    mocks.serviceLoaded.mockResolvedValue(true);
    primeServiceCommand([nodeExecutable, oldEntrypoint, "gateway", "run"]);
    mockGatewayInstallFailure(updatedEntrypoint);
    mockGatewayHealth("2026.4.24", "matching-old-service");

    await runUpdate({ yes: true });

    expect(check.gatewayCommandCall(updatedEntrypoint, "install")?.[0]).toContain("--force");
    expect(check.gatewayCommandCall(updatedEntrypoint, "restart")).toBeUndefined();
    check.expectNoSideEffects(mocks.serviceStop, mocks.serviceStart, mocks.serviceRestart);
    expect(restarts()).toHaveLength(0);
    expect(check.getErrorOutput()).toContain(
      `Failed to reconcile gateway service with ${updatedRoot}`,
    );
    expect(runtime.exit).not.toHaveBeenCalledWith(1);
  });

  it("shows the matching-version probe failure when a JSON package update restart stays unhealthy", async () => {
    setupNpmUpdatedRootRefresh();
    mocks.serviceLoaded.mockResolvedValue(true);
    mocks.restartHealthTestControl.snapshot = {
      runtime: { status: "running", pid: mocks.gatewayFixturePid },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: mocks.gatewayFixturePid, command: "openclaw-gateway" }],
        hints: [],
      },
      healthy: false,
      staleGatewayPids: [],
      gatewayVersion: "2026.4.24",
      expectedVersion: "2026.4.24",
      probeError: "timeout",
      waitOutcome: "timeout",
      elapsedMs: 60_000,
    };

    await expect(runUpdate({ yes: true, json: true, timeout: "123" })).rejects.toEqual(
      new cli.ExitError(1),
    );

    expect(check.lastWriteJsonCall()).toMatchObject({
      status: "error",
      steps: expect.arrayContaining([
        expect.objectContaining({ name: "gateway verification", exitCode: 1 }),
      ]),
    });
    const diagnostics = check.getErrorOutput();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(diagnostics).toContain("Gateway check failed: timeout");
    expect(diagnostics).toContain("Port 18789 is already in use.");
    expect(diagnostics).not.toContain("Gateway version mismatch");
  });
  it("routes a stored dev channel on package installs to the existing Git checkout", async () => {
    vi.mocked(cli.readConfigFileSnapshot).mockResolvedValue(
      configSnapshot({ update: { channel: "dev" } }),
    );
    const prefix = createCaseDir("openclaw-update-git-prefix");
    const { nodeModules } = await setupInstalledPackageAtNodeModules(
      path.join(prefix, "lib", "node_modules"),
      "1.0.0",
    );
    const gitRoot = createCaseDir("openclaw-update-git");
    const sha = "a".repeat(40);
    await writeOpenClawPackageFixture(gitRoot, "2026.8.17", {
      git: true,
      builtSha: sha,
      entrySource: "export {};\n",
    });
    const canonicalGitRoot = await fs.realpath(gitRoot);
    vi.mocked(cli.resolveUpdateInstallKind).mockImplementation(async (root) =>
      root === canonicalGitRoot ? "git" : "package",
    );
    vi.mocked(cli.resolveUpdateInstallIdentity).mockImplementation(async ({ root }) => ({
      installKind: root === canonicalGitRoot ? "git" : "package",
    }));
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, undefined, canonicalGitRoot);
    cli.mockGitUpdateAfterMutation(
      cli.makeOkUpdateResult({
        mode: "git",
        root: canonicalGitRoot,
        after: { sha, version: "2026.8.17" },
      }),
    );
    await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, () => runUpdate({ yes: true }));
    check.expectUpdateCallChannel("dev");
  });

  it("uses the installed Git CLI when service env refresh cannot complete", async () => {
    await runRestartFallbackScenario({ daemonInstall: "fail" });
    check.expectNoSideEffects(cli.runDaemonInstall, cli.runDaemonRestart);
  });
  it("defaults to dev channel for git installs when unset", async () => {
    const root = createCaseDir("openclaw-routing-legacy-git");
    await writeOpenClawPackageFixture(root, "1.0.0", { git: true, entrySource: "export {};\n" });
    mockFileBackedPathExists();
    const canonicalRoot = await fs.realpath(root);
    vi.mocked(cli.resolveOpenClawPackageRoot).mockResolvedValue(canonicalRoot);
    vi.mocked(cli.resolveOpenClawPackageRootSync).mockReturnValue(canonicalRoot);
    vi.mocked(cli.resolveUpdateInstallKind).mockImplementation(async (target) => {
      expect(target).toBe(canonicalRoot);
      return "git";
    });
    vi.mocked(gitUpdate).mockResolvedValue(
      cli.makeOkUpdateResult({ mode: "git", root: canonicalRoot }),
    );
    await runUpdate({});
    check.expectUpdateCallChannel("dev");
  });
});
