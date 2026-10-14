import fs from "node:fs/promises";
import path from "node:path";
import { CANCEL_SYMBOL } from "@clack/core";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyDevUpdateTargetEnv } from "../infra/update-dev-target.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import {
  commandCalls,
  expectNoSideEffects,
  expectPackageInstallSpec,
  getLogOutput,
  lastNpmPluginUpdateCall,
  lastReplaceConfigCall,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
  spawnCall,
  syncPluginCall,
  freshRestartCalls,
  gatewayCommandCall,
  getErrorOutput,
  expectUpdateCallChannel,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  checkShellCompletionStatus,
  confirm,
  installCompletion,
  launchdUpdateCleanupMocks,
  pathExists,
  readPackageVersion,
  runtimeCapture,
  select,
  sourceRuntimeCompletion,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
  gatewayFixturePid,
  restartHealthTestControl,
  serviceLoaded,
  serviceRestart,
  serviceStart,
  serviceStop,
} from "./update-cli-mocks.test-support.js";
import {
  checkUpdateStatus,
  defaultRuntime,
  devTargetRefusalCases,
  ExitError,
  invokeUpdateCli,
  listUpdateRuns,
  makeOkUpdateResult,
  mutateConfigFileWithRetry,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
  registerUpdateCli,
  replaceConfigFile,
  resolveExtendedStablePackage,
  resolveUpdateInstallIdentity,
  resolveUpdateInstallKind,
  runCommandWithTimeout,
  runDaemonInstall,
  runDaemonRestart,
  runExec,
  runUpdateFailureTriage,
  updateCliShared,
  updateCommand,
  updateGitCheckout,
  updateStatusCommand,
  updateWizardCommand,
  mockGitUpdateAfterMutation,
  resolveGatewayInstallEntrypoint,
  resolveOpenClawPackageRoot,
  resolveOpenClawPackageRootSync,
} from "./update-cli-modules.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
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
      await expect(updateCommand({ yes: true })).rejects.toThrow("OPENCLAW_NIX_MODE=1");
    });

    expect(launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob).toHaveBeenCalledOnce();
    expectNoSideEffects(updateGitCheckout, replaceConfigFile, updateNpmInstalledPlugins);
  });

  it("delegates mutating updates when an external supervisor owns gateway lifecycle", async () => {
    await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
      await invokeUpdateCli({ yes: true });
    });

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(runtimeCapture.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Use the external supervisor's update workflow so it can stop the gateway",
      ),
    );
    expectNoSideEffects(
      updateGitCheckout,
      readConfigFileSnapshot,
      replaceConfigFile,
      updateNpmInstalledPlugins,
    );
  });

  it("logs friendly hint with manual refresh command when completion cache write times out", async () => {
    const root = createCaseDir("openclaw-completion-timeout-msg");
    pathExists.mockResolvedValue(true);
    vi.mocked(runCommandWithTimeout).mockResolvedValueOnce(
      commandResult({ code: 124, killed: true, termination: "timeout" }),
    );
    vi.mocked(runtimeCapture.log).mockClear();

    await updateCliShared.tryWriteCompletionCache(root, false);

    const logOutput = getLogOutput();
    expect(logOutput).toContain("timed out after 30s");
    expect(logOutput).toContain("openclaw completion --write-state");
  });

  it("keeps update completion refresh best-effort when profile install fails", async () => {
    setTty(true);
    checkShellCompletionStatus.mockResolvedValue({
      shell: "zsh",
      profileInstalled: true,
      cacheExists: true,
      cachePath: "/tmp/openclaw-completion.zsh",
      usesSlowPattern: true,
    });
    installCompletion.mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await updateCommand({ yes: true, restart: false });

    const logOutput = getLogOutput();
    expect(logOutput).toContain("Shell completion refresh failed: EACCES: permission denied");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it.each([false])("honors --yes=%s for optional shell completion setup", async (yes) => {
    setTty(true);
    confirm.mockResolvedValue(true);

    await updateCommand({ yes, restart: false });

    expect(confirm).toHaveBeenCalledTimes(yes ? 0 : 1);
    if (yes) {
      expect(installCompletion).not.toHaveBeenCalled();
    } else {
      expect(installCompletion).toHaveBeenCalledWith("zsh", false, "openclaw");
    }
  });

  it.each([false, true])(
    "renders update status before invalid config warnings with json=%s",
    async (json) => {
      const sourceConfig = {
        update: { channel: "dev" as const },
        meta: { lastTouchedVersion: "2026.7.35", lastTouchedAt: "2026-07-31T12:00:00.000Z" },
      };
      vi.mocked(readSourceConfigBestEffort).mockResolvedValue(sourceConfig);

      await updateStatusCommand({ json });

      const issue = 'meta: Unrecognized key: "lastTouchedAt"';
      if (json) {
        expect(requireValue(lastWriteJsonCall(), "update status JSON output")).toMatchObject({
          channel: { value: "dev", config: "dev" },
          configWarnings: expect.arrayContaining([
            expect.stringContaining(issue),
            expect.stringContaining("openclaw doctor --fix"),
          ]),
        });
      } else {
        const output = getLogOutput();
        expect(output).toContain("OpenClaw update status");
        expect(output).toContain(`Warning: ${issue}`);
        expect(output).toContain("openclaw doctor --fix");
        expect(output.indexOf(`Warning: ${issue}`)).toBeGreaterThan(output.indexOf("Channel"));
      }
      expect(checkUpdateStatus).toHaveBeenCalledWith(
        expect.objectContaining({ useDetachedDevUpstream: true }),
      );
      expect(readSourceConfigBestEffort).toHaveBeenCalledOnce();
      expect(readConfigFileSnapshot).not.toHaveBeenCalled();
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
        vi.mocked(resolveUpdateInstallKind).mockResolvedValue("git");
        vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "git" });
      }
      if (storedChannel) {
        vi.mocked(readConfigFileSnapshot).mockResolvedValue(
          configSnapshot({ update: { channel: storedChannel } }),
        );
      }
      await updateCommand({ yes: true, tag, channel });
      expectPackageInstallSpec("openclaw@9999.0.0");
      if (channel) {
        expect(replaceConfigFile).toHaveBeenCalledTimes(1);
        expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe(channel);
      }
    },
  );

  it("installs the verified exact package and persists an explicit extended-stable channel", async () => {
    await mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValueOnce("1.0.0").mockResolvedValue("2026.6.33");

    await updateCommand({ channel: "extended-stable", yes: true, restart: false });

    expect(resolveExtendedStablePackage).toHaveBeenCalledWith({
      installKind: "package",
      timeoutMs: undefined,
      packageName: "openclaw",
    });
    expectPackageInstallSpec("openclaw@2026.6.33");
    expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("extended-stable");
    expect(syncPluginCall()?.channel).toBe("extended-stable");
    expect(syncPluginCall()?.coreVersion).toBe("2026.6.33");
    expect(lastNpmPluginUpdateCall()?.updateChannel).toBe("extended-stable");
    expect(lastNpmPluginUpdateCall()?.coreVersion).toBe("2026.6.33");
  });

  it.each([{ name: "stored", explicit: false }])(
    "rejects --tag for an $name extended-stable channel",
    async ({ explicit }) => {
      await mockPackageInstallAtCaseDir();
      if (!explicit) {
        const config = { update: { channel: "extended-stable" } } as OpenClawConfig;
        vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
      }

      await expect(
        updateCommand({
          ...(explicit ? { channel: "extended-stable" as const } : {}),
          tag: "latest",
          yes: true,
        }),
      ).rejects.toEqual(new ExitError(1));

      expect(resolveExtendedStablePackage).not.toHaveBeenCalled();
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
      expectNoSideEffects(
        replaceConfigFile,
        launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
    },
  );

  it("rejects extended-stable Git updates before handoff, conversion, or config mutation", async () => {
    await expect(updateCommand({ channel: "extended-stable", yes: true })).rejects.toEqual(
      new ExitError(1),
    );

    expectNoSideEffects(
      resolveExtendedStablePackage,
      updateGitCheckout,
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(commandCalls().every(([argv]) => argv[0] === "git" && argv.includes("rev-parse"))).toBe(
      true,
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
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
      vi.mocked(defaultRuntime.error).mockClear();
      vi.mocked(defaultRuntime.exit).mockClear();
      const runsBefore = listUpdateRuns();
      const program = new Command();
      registerUpdateCli(program);

      await program.parseAsync([...argv], { from: "user" });

      expect(vi.mocked(defaultRuntime.error).mock.calls).toEqual([[expectedError]]);
      expect(vi.mocked(defaultRuntime.exit).mock.calls).toEqual([[1]]);
      expect(listUpdateRuns()).toEqual(runsBefore);
      expectNoSideEffects(
        readConfigFileSnapshot,
        cleanupStaleManagedServiceUpdateHandoffs,
        runDaemonInstall,
        runDaemonRestart,
      );
    },
  );

  it.each(["wizard"])(
    "routes an invalid %s timeout to the outer JSON error owner",
    async (command) => {
      setTty(true);
      const previousArgv = process.argv;
      process.argv = ["node", "openclaw", "update", "--json", command, "--timeout", "invalid"];
      const program = new Command();
      registerUpdateCli(program);
      const runsBefore = listUpdateRuns();
      try {
        await expect(
          withConsoleLogsRoutedToStderrForJson(process.argv, () =>
            program.parseAsync(process.argv),
          ),
        ).rejects.toThrow("--timeout must be a positive integer (seconds)");
      } finally {
        process.argv = previousArgv;
      }

      expect(listUpdateRuns()).toEqual(runsBefore);
      expectNoSideEffects(
        defaultRuntime.error,
        defaultRuntime.exit,
        defaultRuntime.writeJson,
        readConfigFileSnapshot,
        cleanupStaleManagedServiceUpdateHandoffs,
        runDaemonInstall,
        runDaemonRestart,
      );
    },
  );

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
    const runsBefore = listUpdateRuns();
    if (shouldRunPackageUpdate) {
      mockCurrentProcessFreshDoctor({ packageRoot: root, postCoreResumeAttempt: false });
    }
    if (shouldExit) {
      await expect(updateCommand(options)).rejects.toEqual(new ExitError(1));
      expect(listUpdateRuns()).toEqual(runsBefore);
      await expect(fs.stat(`${profileStateDir()}.update-captures`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expectNoSideEffects(
        replaceConfigFile,
        mutateConfigFileWithRetry,
        runDaemonInstall,
        runDaemonRestart,
      );
    } else {
      await updateCommand(options);
    }
    expect(getLogOutput().includes("Downgrade confirmation required.")).toBe(shouldExit);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(updateGitCheckout).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(runCommandWithTimeout)
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
        select.mockResolvedValue(CANCEL_SYMBOL);
      } else {
        confirm.mockResolvedValue(CANCEL_SYMBOL);
      }
      vi.mocked(checkUpdateStatus).mockRejectedValue(new Error("Freshness inspection unavailable"));

      await updateWizardCommand();

      expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Update channel" }));
      expect(defaultRuntime.log).toHaveBeenCalledWith(expect.stringContaining("Update cancelled."));
      expect(updateGitCheckout).not.toHaveBeenCalled();
      expect(sourceRuntimeCompletion).not.toHaveBeenCalled();
    },
  );

  it.each(["before"])(
    "update wizard forwards explicit consent %s the subcommand",
    async (position) => {
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
            const stagingDir = requireValue(argv.at(-1), "clone destination");
            await writeOpenClawPackageFixture(stagingDir, "2026.8.1", { git: true });
            return commandResult();
          }
          return undefined;
        },
        tempDir,
      );
      vi.spyOn(updateCliShared, "tryWriteCompletionCache").mockResolvedValueOnce("completed");
      await withEnvAsync({ OPENCLAW_GIT_DIR: tempDir }, async () => {
        setTty(true);
        select.mockResolvedValue("dev");
        confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        vi.mocked(updateGitCheckout).mockImplementation(async ({ opts: options }) => {
          await writeOpenClawPackageFixture(tempDir, "2026.8.1", { git: true, builtSha: sha });
          await options.prepareGitExposure?.(tempDir, sha, undefined);
          await options.validateCandidate(tempDir);
          await requireValue(options.beforeGitMutation, "Git mutation admission")({});
          return makeOkUpdateResult({
            root: tempDir,
            after: { sha, version: "2026.8.1" },
          });
        });
        const runFixtureExec = requireValue(
          vi.mocked(runExec).getMockImplementation(),
          "exec fixture",
        );
        vi.mocked(runExec).mockImplementation((file, args, options) => {
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
        registerUpdateCli(program);
        await program.parseAsync([
          "node",
          "openclaw",
          "update",
          ...(position === "before" ? ["--accept-capabilities"] : []),
          "wizard",
          ...(position === "after" ? ["--accept-capabilities"] : []),
        ]);

        expect(readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
        const call = vi.mocked(updateGitCheckout).mock.calls[0]?.[0];
        expect(call?.opts.channel).toBe("dev");
        await expect(fs.realpath(packageRoot)).resolves.toBe(tempDir);
        expect(spawnCall()?.[1]).toEqual([
          path.join(tempDir, "dist", "entry.js"),
          "update",
          "--no-restart",
          "--accept-capabilities",
          "--timeout",
          "1800",
        ]);
        expectNoSideEffects(syncPluginsForUpdateChannel, updateNpmInstalledPlugins);
        expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      });
    },
  );

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
      await updateCommand({ channel: "dev", yes: true, restart: false });
    });

    expect(vi.mocked(updateGitCheckout).mock.calls[0]?.[0]?.opts).toEqual(
      expect.objectContaining({ devTarget: expected }),
    );
  });

  it.each([devTargetRefusalCases[4]])(
    "rejects a %s dev target before running the update",
    async (_name, value) => {
      const diagnostic =
        "Invalid internal OPENCLAW_UPDATE_DEV_TARGET_REF contract; expected a plain Git ref or a supported tracked-target encoding.";
      await withEnvAsync({ OPENCLAW_UPDATE_DEV_TARGET_REF: value }, async () => {
        const command = invokeUpdateCli({
          json: true,
          yes: true,
          restart: false,
        });
        await expect(command).rejects.toEqual(new ExitError(1));
      });

      expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith(diagnostic);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expectNoSideEffects(
        runUpdateFailureTriage,
        cleanupStaleManagedServiceUpdateHandoffs,
        updateGitCheckout,
        replaceConfigFile,
        mutateConfigFileWithRetry,
        runDaemonInstall,
        runDaemonRestart,
        syncPluginsForUpdateChannel,
        updateNpmInstalledPlugins,
        launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      const runs = listUpdateRuns();
      expect(runs).toHaveLength(1);
      expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
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
    vi.mocked(defaultRuntime.log).mockClear();
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();
    vi.mocked(updateGitCheckout).mockResolvedValue({
      status,
      mode: "git",
      reason: "dirty",
      steps: [],
      durationMs: 100,
    } satisfies UpdateRunResult);

    await expect(updateCommand({ channel: "dev" })).rejects.toEqual(new ExitError(1));

    const logs = getLogOutput();
    expect(logs).toContain(`OpenClaw update ${status === "error" ? "failed" : "skipped"}: dirty.`);
    expect(logs).toContain(
      "Local changes prevented this update before installation. Your checkout was preserved.",
    );
    expect(logs).toContain("Commit your changes and retry, or run `openclaw triage` for help.");
    expect(listUpdateRuns({ limit: 1 })[0]?.origin.nextAction).toContain(
      "Commit your changes and retry",
    );
    expect(serviceStop).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });
  it("reports activation failure when the updated CLI entrypoint is missing", async () => {
    const root = await mockPackageInstallAtCaseDir();
    mockRunningManagedGateway([
      nodeExecutable,
      path.join(root, "dist", "index.js"),
      "gateway",
      "run",
    ]);
    vi.mocked(resolveGatewayInstallEntrypoint).mockReset().mockResolvedValue(undefined);
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(serviceStart).not.toHaveBeenCalled();
    expect(freshRestartCalls().length).toBe(0);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([true])(
    "tries the updated install restart when package service refresh fails (JSON: %s)",
    async (json) => {
      const { updatedRoot, updatedEntrypoint } = setupNpmUpdatedRootRefresh();
      serviceLoaded.mockResolvedValue(true);
      primeServiceCommand([nodeExecutable, updatedEntrypoint, "gateway", "run"]);
      mockGatewayInstallFailure(updatedEntrypoint, json ? "runtime warning" : undefined);
      mockGatewayHealth("2026.4.24", "updated-gateway");

      await updateCommand({ yes: true, json });

      expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
      const restartCall = gatewayCommandCall(updatedEntrypoint, "restart");
      expect(restartCall?.[0].slice(4)).toEqual([
        "--preserve-definition",
        "--json",
        "--update-executor",
        "run",
      ]);
      expect(restartCall?.[1].cwd).toBe(updatedRoot);
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      if (json) {
        expect(getErrorOutput()).toContain(
          "SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: Error: launchctl bootstrap failed",
        );
      } else {
        expect(getLogOutput()).toContain("Gateway: restarted and verified.");
      }
    },
  );

  it("warns without restarting a stale same-version service when installation reconciliation fails", async () => {
    const oldRoot = createCaseDir("openclaw-old-root");
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const oldEntrypoint = path.join(oldRoot, "dist", "entry.js");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    setupUpdatedRootRefresh({
      entrypoints: [oldEntrypoint, updatedEntrypoint],
      targetVersion: "2026.4.24",
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.24" },
          after: { version: "2026.4.24" },
        }),
    });
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand([nodeExecutable, oldEntrypoint, "gateway", "run"]);
    mockGatewayInstallFailure(updatedEntrypoint);
    mockGatewayHealth("2026.4.24", "matching-old-service");

    await updateCommand({ yes: true });

    expect(gatewayCommandCall(updatedEntrypoint, "install")?.[0]).toContain("--force");
    expect(gatewayCommandCall(updatedEntrypoint, "restart")).toBeUndefined();
    expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
    expect(freshRestartCalls()).toHaveLength(0);
    expect(getErrorOutput()).toContain(`Failed to reconcile gateway service with ${updatedRoot}`);
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("shows the matching-version probe failure when a JSON package update restart stays unhealthy", async () => {
    setupNpmUpdatedRootRefresh();
    serviceLoaded.mockResolvedValue(true);
    restartHealthTestControl.snapshot = {
      runtime: { status: "running", pid: gatewayFixturePid },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: gatewayFixturePid, command: "openclaw-gateway" }],
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

    await expect(updateCommand({ yes: true, json: true, timeout: "123" })).rejects.toEqual(
      new ExitError(1),
    );

    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      steps: expect.arrayContaining([
        expect.objectContaining({ name: "gateway verification", exitCode: 1 }),
      ]),
    });
    const diagnostics = getErrorOutput();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(diagnostics).toContain("Gateway check failed: timeout");
    expect(diagnostics).toContain("Port 18789 is already in use.");
    expect(diagnostics).not.toContain("Gateway version mismatch");
  });
  it("routes a stored dev channel on package installs to the existing Git checkout", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(
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
    vi.mocked(resolveUpdateInstallKind).mockImplementation(async (root) =>
      root === canonicalGitRoot ? "git" : "package",
    );
    vi.mocked(resolveUpdateInstallIdentity).mockImplementation(async ({ root }) => ({
      installKind: root === canonicalGitRoot ? "git" : "package",
    }));
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, undefined, canonicalGitRoot);
    mockGitUpdateAfterMutation(
      makeOkUpdateResult({
        mode: "git",
        root: canonicalGitRoot,
        after: { sha, version: "2026.8.17" },
      }),
    );
    await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, () => updateCommand({ yes: true }));
    expectUpdateCallChannel("dev");
  });

  it("uses the installed Git CLI when service env refresh cannot complete", async () => {
    await runRestartFallbackScenario({ daemonInstall: "fail" });
    expectNoSideEffects(runDaemonInstall, runDaemonRestart);
  });
  it("defaults to dev channel for git installs when unset", async () => {
    const root = createCaseDir("openclaw-routing-legacy-git");
    await writeOpenClawPackageFixture(root, "1.0.0", { git: true, entrySource: "export {};\n" });
    mockFileBackedPathExists();
    const canonicalRoot = await fs.realpath(root);
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(canonicalRoot);
    vi.mocked(resolveOpenClawPackageRootSync).mockReturnValue(canonicalRoot);
    vi.mocked(resolveUpdateInstallKind).mockImplementation(async (target) => {
      expect(target).toBe(canonicalRoot);
      return "git";
    });
    vi.mocked(updateGitCheckout).mockResolvedValue(
      makeOkUpdateResult({ mode: "git", root: canonicalRoot }),
    );
    await updateCommand({});
    expectUpdateCallChannel("dev");
  });
});
