import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CANCEL_SYMBOL } from "@clack/core";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBetaTag } from "../infra/update-channels.js";
import { applyDevUpdateTargetEnv } from "../infra/update-dev-target.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import {
  commandCalls,
  completionCommandCall,
  expectNoSideEffects,
  expectPackageInstallSpec,
  expectUpdateCallChannel,
  getLogOutput,
  lastNpmPluginUpdateCall,
  lastReplaceConfigCall,
  lastWriteJsonCall,
  packageInstallCommandCall,
  replaceConfigCall,
  requireValue,
  spawnCall,
  syncPluginCall,
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
} from "./update-cli-mocks.test-support.js";
import {
  checkUpdateStatus,
  defaultRuntime,
  devTargetRefusalCases,
  ExitError,
  invokeUpdateCli,
  listUpdateRuns,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  mutateConfigFileWithRetry,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
  registerUpdateCli,
  replaceConfigFile,
  resolveExtendedStablePackage,
  resolveGitInstallDir,
  resolveOpenClawPackageRoot,
  resolveOpenClawPackageRootSync,
  resolveUpdateInstallIdentity,
  resolveUpdateInstallKind,
  runCommandWithTimeout,
  runDaemonInstall,
  runDaemonRestart,
  runExec,
  runPostCorePluginConvergenceSpy,
  runUpdateFailureTriage,
  updateCliShared,
  updateCommand,
  updateGitCheckout,
  updateStatusCommand,
  updateWizardCommand,
} from "./update-cli-modules.test-support.js";
import { mockPostCoreConvergenceOnce } from "./update-cli/update-cli-config.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseSnapshot,
    configSnapshot,
    createCaseDir,
    mockCurrentProcessFreshDoctor,
    mockFileBackedPathExists,
    mockNpmGlobalCommands,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    runUpdateCliScenario,
    setTty,
    setupInstalledPackageAtNodeModules,
    setupNonInteractiveDowngrade,
    tempDirs,
  } = createUpdateCliFixture();

  it("reads the initial update config without schema validation or observation", async () => {
    await updateCommand({ yes: true, restart: false });

    expect(vi.mocked(readConfigFileSnapshot).mock.calls[0]?.[0]).toEqual({
      skipPluginValidation: true,
      observe: false,
    });
  });

  it.each([undefined, 1_200])(
    "passes the completion refresh budget %s and core-only command scope",
    async (timeoutMs) => {
      const root = createCaseDir("openclaw-completion-timeout");
      pathExists.mockResolvedValue(true);

      await expect(updateCliShared.tryWriteCompletionCache(root, false, timeoutMs)).resolves.toBe(
        "completed",
      );

      const call = completionCommandCall();
      expect(call?.[0]).toEqual([
        expect.any(String),
        path.join(root, "openclaw.mjs"),
        "completion",
        "--write-state",
      ]);
      expect(call?.[1]).toMatchObject({
        env: { OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS: "1" },
        timeoutMs: timeoutMs ?? 30_000,
        killProcessTree: true,
      });
    },
  );

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

  it.each([true, false])("honors --yes=%s for optional shell completion setup", async (yes) => {
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

  it.each([
    {
      name: "table output",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        await updateStatusCommand({ json: false });
      },
      assert: () => {
        expect(getLogOutput()).toContain("OpenClaw update status");
        expect(checkUpdateStatus).toHaveBeenCalledWith(
          expect.objectContaining({ useDetachedDevUpstream: false }),
        );
      },
    },
    {
      name: "json output",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        await updateStatusCommand({ json: true });
      },
      assert: () => {
        const last = requireValue(lastWriteJsonCall(), "update status JSON output");
        const parsed = last as Record<string, unknown>;
        const channel = parsed.channel as { value?: unknown };
        expect(channel.value).toBe(isBetaTag(VERSION) ? "beta" : "stable");
      },
    },
  ] as const)("updateStatusCommand rendering: $name", runUpdateCliScenario);

  it("renders update status when unrelated config validation would fail", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      valid: false,
      config: {} as OpenClawConfig,
    });
    vi.mocked(readSourceConfigBestEffort).mockResolvedValue({
      update: { channel: "dev" },
    } as OpenClawConfig);

    await updateStatusCommand({ json: true });

    const last = requireValue(lastWriteJsonCall(), "update status JSON output");
    const parsed = last as Record<string, unknown>;
    const channel = parsed.channel as { value?: unknown; config?: unknown };
    expect(channel.value).toBe("dev");
    expect(channel.config).toBe("dev");
    expect(checkUpdateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ useDetachedDevUpstream: true }),
    );
  });

  it.each([
    {
      name: "defaults to dev channel for git installs when unset",
      installKind: "git" as const,
      options: {},
      storedChannel: undefined,
      expectedChannel: "dev" as const,
      expectedPersistedChannel: undefined,
    },
    {
      name: "defaults to stable channel for package installs when unset",
      installKind: "package" as const,
      options: { yes: true },
      storedChannel: undefined,
      expectedChannel: undefined,
      expectedPersistedChannel: undefined,
    },
    {
      name: "uses stored beta channel when configured",
      installKind: "git" as const,
      options: {},
      storedChannel: "beta" as const,
      expectedChannel: "beta" as const,
      expectedPersistedChannel: undefined,
    },
    {
      name: "routes a stored dev channel on package installs to the git update flow",
      installKind: "package" as const,
      options: { yes: true },
      storedChannel: "dev" as const,
      expectedChannel: "dev" as const,
      expectedPersistedChannel: undefined,
    },
    {
      name: "keeps a stored-dev package install on the package path for a one-off --tag",
      installKind: "package" as const,
      options: { tag: "latest", yes: true },
      storedChannel: "dev" as const,
      expectedChannel: undefined,
      expectedPersistedChannel: undefined,
    },
    {
      name: "keeps explicit dev channel precedence over a one-off --tag",
      installKind: "package" as const,
      options: { channel: "dev", tag: "latest", yes: true },
      storedChannel: "dev" as const,
      expectedChannel: "dev" as const,
      expectedPersistedChannel: undefined,
    },
    {
      name: "switches git installs to package mode for explicit beta and persists it",
      installKind: "git" as const,
      options: { channel: "beta" },
      storedChannel: undefined,
      expectedChannel: undefined,
      expectedPersistedChannel: "beta" as const,
    },
  ] as const)(
    "$name",
    async ({ installKind, options, storedChannel, expectedChannel, expectedPersistedChannel }) => {
      let gitRoutingRoot: string | undefined;
      if (installKind === "git" && expectedChannel !== undefined) {
        const root = createCaseDir("openclaw-routing-legacy-git");
        await writeOpenClawPackageFixture(root, "1.0.0", {
          git: true,
          entrySource: "export {};\n",
        });
        mockFileBackedPathExists();
        gitRoutingRoot = await fs.realpath(root);
        vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(gitRoutingRoot);
        vi.mocked(resolveOpenClawPackageRootSync).mockReturnValue(gitRoutingRoot);
        vi.mocked(resolveUpdateInstallKind).mockImplementation(async (target) => {
          expect(target).toBe(gitRoutingRoot);
          return "git";
        });
      }
      if (installKind === "package" && expectedChannel === undefined) {
        await mockPackageInstallAtCaseDir();
      }
      if (installKind === "git" && expectedChannel === undefined) {
        await mockPackageInstallAtCaseDir();
        vi.mocked(resolveUpdateInstallKind).mockResolvedValue("git");
        vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "git" });
      }
      if (installKind === "git" || expectedChannel !== undefined) {
        vi.mocked(updateGitCheckout).mockResolvedValue(
          makeOkUpdateResult({ mode: "git", root: gitRoutingRoot }),
        );
      }
      if (storedChannel) {
        vi.mocked(readConfigFileSnapshot).mockResolvedValue({
          ...baseSnapshot,
          config: { update: { channel: storedChannel } } as OpenClawConfig,
        });
      }

      if (installKind === "package" && expectedChannel !== undefined) {
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
        await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
          await updateCommand(options);
        });
      } else {
        await updateCommand(options);
      }

      if (expectedChannel !== undefined) {
        expectUpdateCallChannel(expectedChannel);
      } else {
        expectPackageInstallSpec("openclaw@9999.0.0");
      }

      if (expectedPersistedChannel !== undefined) {
        expect(replaceConfigFile).toHaveBeenCalledTimes(1);
        const writeCall = replaceConfigCall() as
          | { nextConfig?: { update?: { channel?: string } } }
          | undefined;
        expect(writeCall?.nextConfig?.update?.channel).toBe(expectedPersistedChannel);
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

  it("uses the same exact resolver for a bare update with stored extended-stable", async () => {
    await mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValueOnce("1.0.0").mockResolvedValue("2026.6.33");
    const config = { update: { channel: "extended-stable" } } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));

    await updateCommand({ yes: true, restart: false });

    expect(resolveExtendedStablePackage).toHaveBeenCalledWith({
      installKind: "package",
      timeoutMs: undefined,
      packageName: "openclaw",
    });
    expectPackageInstallSpec("openclaw@2026.6.33");
    expect(syncPluginCall()?.channel).toBe("extended-stable");
    expect(syncPluginCall()?.coreVersion).toBe("2026.6.33");
  });

  it("fails closed without config or package mutation when extended-stable resolution fails", async () => {
    await mockPackageInstallAtCaseDir();
    vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
      status: "failed",
      reason: "selector_missing",
    });

    await expect(updateCommand({ channel: "extended-stable", yes: true })).rejects.toEqual(
      new ExitError(1),
    );

    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(lastWriteJsonCall()).toBeUndefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("fails a stored extended-stable update before launchd cleanup when resolution fails", async () => {
    await mockPackageInstallAtCaseDir();
    const config = { update: { channel: "extended-stable" } } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
    vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
      status: "failed",
      reason: "selector_query_failed",
    });

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { name: "explicit", explicit: true },
    { name: "stored", explicit: false },
  ])("rejects --tag for an $name extended-stable channel", async ({ explicit }) => {
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
  });

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
    { name: "refuses", yes: false, installs: false },
    { name: "allows with --yes", yes: true, installs: true },
  ])("$name an extended-stable downgrade in non-interactive mode", async ({ yes, installs }) => {
    setTty(false);
    await mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.7.10");
    vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
      status: "resolved",
      selector: "extended-stable",
      version: "2026.6.33",
      packageSpec: "openclaw@2026.6.33",
    });

    await updateCommand({ channel: "extended-stable", yes, restart: false });

    expect(packageInstallCommandCall() !== undefined).toBe(installs);
    if (installs) {
      expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("extended-stable");
    } else {
      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    }
  });

  it("finishes the core update and retains extended-stable after a plugin convergence failure", async () => {
    await mockPackageInstallAtCaseDir();
    mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
      warnings: [
        {
          pluginId: "demo",
          reason: "plugin smoke failed",
          message: "plugin smoke failed",
          guidance: ["Run openclaw update repair."],
        },
      ],
      errored: true,
    });

    await updateCommand({ channel: "extended-stable", yes: true, json: true, restart: false });

    expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("extended-stable");
    const output = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(output?.status).toBe("ok");
    expect(output?.postUpdate?.plugins?.status).toBe("warning");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "update command invalid timeout",
      run: async () => await invokeUpdateCli({ timeout: "invalid" }),
      requireTty: false,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update status command invalid timeout",
      run: async () => await updateStatusCommand({ timeout: "invalid" }),
      requireTty: false,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update wizard invalid timeout",
      run: async () => await updateWizardCommand({ timeout: "invalid" }),
      requireTty: true,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update wizard requires a TTY",
      run: async () => await updateWizardCommand({}),
      requireTty: false,
      expectedError:
        "Update wizard requires a TTY. Use `openclaw update --channel <stable|extended-stable|beta|dev>` instead.",
    },
  ] as const)(
    "validates update command invocation errors: $name",
    async ({ run, requireTty, expectedError, name }) => {
      setTty(requireTty);
      vi.mocked(defaultRuntime.error).mockClear();
      vi.mocked(defaultRuntime.exit).mockClear();

      await run();

      expect(defaultRuntime.error, name).toHaveBeenCalledWith(expectedError);
      expect(defaultRuntime.exit, name).toHaveBeenCalledWith(1);
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
    if (shouldRunPackageUpdate) {
      mockCurrentProcessFreshDoctor({ packageRoot: root, postCoreResumeAttempt: false });
    }
    await updateCommand(options);

    const downgradeMessageSeen = vi
      .mocked(defaultRuntime.error)
      .mock.calls.some((call) => String(call[0]).includes("Downgrade confirmation required."));
    expect(downgradeMessageSeen).toBe(shouldExit);
    if (shouldExit) {
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    } else {
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    }
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

  it.each(["before", "after"])(
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
        vi.mocked(runExec).mockResolvedValueOnce({
          stdout: new Command("update").option("--accept-capabilities").helpInformation(),
          stderr: "",
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
      name: "ref-only as detached",
      env: { OPENCLAW_UPDATE_DEV_TARGET_REF: "frozen-sha" },
      expected: { mode: "detached", ref: "frozen-sha" },
    },
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

  it.each(devTargetRefusalCases)(
    "rejects a %s dev target before running the update",
    async (_name, value, inferred, json) => {
      const diagnostic =
        "Invalid internal OPENCLAW_UPDATE_DEV_TARGET_REF contract; expected a plain Git ref or a supported tracked-target encoding.";
      await withEnvAsync({ OPENCLAW_UPDATE_DEV_TARGET_REF: value }, async () => {
        const command = invokeUpdateCli({
          channel: inferred ? undefined : "dev",
          json,
          yes: true,
          restart: false,
        });
        if (inferred) {
          await expect(command).rejects.toEqual(new ExitError(1));
        } else {
          await command;
        }
      });

      expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith(diagnostic);
      expect(getLogOutput()).not.toContain(diagnostic);
      expect(vi.mocked(defaultRuntime.exit).mock.calls).toEqual(inferred ? [] : [[1]]);
      expectNoSideEffects(
        defaultRuntime.writeJson,
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
      expect(runs).toHaveLength(inferred ? 1 : 0);
      if (inferred) {
        expect(runs[0]).toMatchObject({
          status: "failed",
          phase: "finished",
          reason: "invalid-dev-target",
          origin: { nextAction: diagnostic },
        });
        expect(runs[0]?.steps).toContainEqual(
          expect.objectContaining({ step: "invalid-dev-target", status: "failed", exitCode: 1 }),
        );
      }
    },
  );

  it("ignores a malformed dev target for a stable package update", async () => {
    await mockPackageInstallAtCaseDir("openclaw-stable-update");
    mockCurrentProcessFreshDoctor();

    await withEnvAsync(
      { OPENCLAW_UPDATE_DEV_TARGET_REF: "openclaw-dev-target:v1:not+base64url" },
      async () => {
        await updateCommand({ channel: "stable", yes: true, restart: false });
      },
    );

    expect(defaultRuntime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("OPENCLAW_UPDATE_DEV_TARGET_REF"),
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(packageInstallCommandCall()).toBeDefined();
    expect(updateGitCheckout).not.toHaveBeenCalled();
  });

  it("uses ~/openclaw as the default dev checkout directory", async () => {
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/tmp/oc-home");
    try {
      await withEnvAsync(
        {
          HOME: undefined,
          OPENCLAW_GIT_DIR: undefined,
          OPENCLAW_HOME: undefined,
          USERPROFILE: undefined,
        },
        async () => {
          expect(resolveGitInstallDir()).toBe(path.posix.join("/tmp/oc-home", "openclaw"));
        },
      );
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it("uses OPENCLAW_HOME for the default dev checkout directory", async () => {
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/tmp/oc-home");
    try {
      await withEnvAsync(
        { OPENCLAW_GIT_DIR: undefined, OPENCLAW_HOME: "/srv/openclaw-home" },
        async () => {
          expect(resolveGitInstallDir()).toBe(path.posix.join("/srv/openclaw-home", "openclaw"));
        },
      );
    } finally {
      homedirSpy.mockRestore();
    }
  });
});
