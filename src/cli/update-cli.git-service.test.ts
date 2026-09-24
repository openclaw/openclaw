import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { getMockCallOutput } from "./test-runtime-capture.js";
import {
  commandCalls,
  doctorCommandCall,
  expectNoSideEffects,
  freshRestartCalls,
  gatewayCommandCall,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  candidateValidation,
  createPreUpdateConfigSnapshotMock,
  gatewayFixturePid,
  launchdUpdateCleanupMocks,
  readPackageVersion,
  resolveGlobalManager,
  restartHealthTestControl,
  retainUpdateRuntime,
  serviceDefinitionMutationCapability,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  syncPluginsForUpdateChannel,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveOpenClawPackageRoot,
  runCommandWithTimeout,
  runDaemonInstall,
  runDaemonRestart,
  runExec,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  createConfigValidationFailure,
  pluginSyncResult,
} from "./update-cli/update-cli-config.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";
import { createGlobalUserServiceCommand } from "./update-cli/update-command-service-state.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseConfig,
    baseSnapshot,
    configSnapshot,
    createCaseDir,
    expectFailedManagedGitRestart,
    initializeExistingUpdateProfile,
    mockFileBackedPathExists,
    mockGatewayHealth,
    mockNoopPostUpdatePluginConvergence,
    mockNpmGlobalCommands,
    mockNpmGlobalRoot,
    mockPackageInstallStatus,
    mockRunningManagedGateway,
    mockStoppedManagedGitGateway,
    profileStateDir,
    setupInstalledPackageAtNodeModules,
    setupInstalledPackageRoot,
    setupManagedGitRootRefresh,
    tempDirs,
    tempDirsToCleanup,
  } = createUpdateCliFixture();

  it("stops a running managed gateway when git checkout rebuild starts", async () => {
    const serviceEntrypoint = path.join(process.cwd(), "dist", "index.js");
    mockRunningManagedGateway(["node", serviceEntrypoint, "gateway", "run"]);
    const mutationAdmitted = mockGitUpdateAfterMutation(
      makeOkUpdateResult({ root: process.cwd() }),
    );

    await updateCommand({ yes: true });

    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(updateGitCheckout).toHaveBeenCalledTimes(1);
    expect(freshRestartCalls()).toHaveLength(1);
    expect(freshRestartCalls()[0]?.[0]).toEqual([
      process.execPath,
      serviceEntrypoint,
      "gateway",
      "restart",
      "--preserve-definition",
      "--json",
      "--update-executor",
      "run",
    ]);
    const serviceStopCall = serviceStop.mock.calls[0]?.[0] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(serviceStopCall?.env?.OPENCLAW_SERVICE_MARKER).toBe("openclaw");
    expect(serviceStopCall?.env?.OPENCLAW_SERVICE_KIND).toBe("gateway");
    const updateCall = vi.mocked(updateGitCheckout).mock.calls[0]?.[0];
    expect(updateCall?.opts.beforeGitMutation).toEqual(expect.any(Function));
    expect(mutationAdmitted).toHaveBeenCalledOnce();
  });

  it("uses a manager-effective global user unit during update preflight", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const entrypoint = path.join(process.cwd(), "dist", "index.js");
    const command = createGlobalUserServiceCommand(entrypoint);
    serviceReadCommand.mockImplementation(async (_env, options) =>
      options?.requireEffective ? command : null,
    );
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    serviceDefinitionMutationCapability.mockResolvedValue({
      kind: "sealed",
      detail: "privileged global user unit",
    });
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
    mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root: process.cwd() }));

    await updateCommand({ yes: true });

    expect(serviceStop.mock.calls.length).toBe(1);
    expect(vi.mocked(runDaemonInstall).mock.calls.length).toBe(0);
  });

  it.each(["owned", "unresolved"] as const)(
    "inspects an %s service wrapper when openclaw is absent from PATH",
    async (ownership) => {
      const root = createCaseDir("openclaw-update-wrapper-install");
      const entrypoint = await writeOpenClawPackageFixture(root, "1.0.0", {
        git: true,
        entrySource: "export {};\n",
      });
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
      mockFileBackedPathExists();
      const wrapperDir =
        ownership === "owned"
          ? path.join(root, "bin")
          : createCaseDir("openclaw-update-wrapper-service");
      const wrapperPath = path.join(wrapperDir, "gateway-wrapper");
      await fs.mkdir(wrapperDir, { recursive: true });
      await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const stateDir = profileStateDir("wrapper-service");
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
      tempDirsToCleanup.add(stateDir);
      await fs.mkdir(stateDir, { recursive: true });
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.writeFile(configPath, JSON.stringify(baseSnapshot.config));
      const serviceEnv = {
        ...process.env,
        OPENCLAW_PROFILE: "wrapper-service",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_WRAPPER: wrapperPath,
        PATH: path.dirname(process.execPath),
      };
      const { buildGatewayInstallPlan } = await import("../commands/daemon-install-helpers.js");
      const initialPlan = await buildGatewayInstallPlan({
        env: serviceEnv,
        config: baseSnapshot.config,
        port: 18789,
        runtime: "node",
        runtimePath: process.execPath,
        wrapperPath,
      });
      const existingEnvironment = Object.fromEntries(
        Object.entries(initialPlan.environment).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      const { resolveOwnedManagedUpdateEnv } =
        await import("./update-cli/update-command-service-env.js");
      const { mergeInstallInvocationEnv } = await import("./daemon-cli/install.js");
      const ownedEnv = resolveOwnedManagedUpdateEnv({
        serviceEnv: { ...process.env, ...existingEnvironment },
        serviceDefinitionEnv: existingEnvironment,
        invocationCwd: process.cwd(),
      });
      const installEnv = mergeInstallInvocationEnv({
        env: ownedEnv,
        existingServiceEnv: existingEnvironment,
      });
      const servicePlan = await buildGatewayInstallPlan({
        env: installEnv,
        config: baseSnapshot.config,
        port: 18789,
        runtime: "node",
        wrapperPath,
        existingEnvironment,
        existingEnvironmentValueSources: initialPlan.environmentValueSources,
      });
      const serviceCommand = {
        ...servicePlan,
        environment: {
          ...Object.fromEntries(
            Object.entries(servicePlan.environment).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          // This sealed service deliberately has no CLI on PATH, including host-wide installs.
          PATH: wrapperDir,
        },
      };
      serviceReadCommand.mockResolvedValue(serviceCommand);
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockImplementation(async () =>
        serviceStop.mock.calls.length === 0 || freshRestartCalls().length > 0
          ? { status: "running", pid: gatewayFixturePid, state: "running" }
          : { status: "stopped", pid: null, state: "stopped" },
      );
      serviceDefinitionMutationCapability.mockResolvedValue({
        kind: "sealed",
        detail: "privileged wrapper owner",
      });
      const { resolveExecutablePath } = await import("../infra/executable-path.js");
      expect(
        resolveExecutablePath("openclaw", { env: serviceCommand.environment }),
      ).toBeUndefined();
      const envSnapshot = captureEnv(Object.keys(serviceCommand.environment));
      mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root }));
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);

      try {
        await updateCommand({ yes: true });
      } finally {
        envSnapshot.restore();
        const { clearConfigCache } = await import("../config/io.js");
        const { clearRuntimeConfigSnapshot } = await import("../config/runtime-snapshot.js");
        clearConfigCache();
        clearRuntimeConfigSnapshot();
      }

      if (ownership === "unresolved") {
        expect(getLogOutput()).toContain("Restart the Gateway you launched manually");
        expect(updateGitCheckout).toHaveBeenCalledOnce();
        expectNoSideEffects(
          serviceStop,
          serviceStart,
          serviceRestart,
          runDaemonInstall,
          runDaemonRestart,
        );
        expect(freshRestartCalls()).toHaveLength(0);
        return;
      }
      expect(getErrorOutput()).toContain("service definition left unchanged");
      expect(serviceStop).toHaveBeenCalledTimes(1);
      expect(updateGitCheckout).toHaveBeenCalledTimes(1);
      const restartOptions = freshRestartCalls()[0]?.[1];
      expect(typeof restartOptions === "object" && restartOptions.env?.OPENCLAW_WRAPPER).toBe(
        wrapperPath,
      );
      expect(serviceStart).not.toHaveBeenCalled();
      expectNoSideEffects(runDaemonInstall, runDaemonRestart);
    },
  );

  it("fails managed git restart when the gateway responds but the service stays stopped", async () => {
    mockStoppedManagedGitGateway();
    restartHealthTestControl.snapshot = {
      runtime: { status: "stopped", pid: null, state: "stopped" },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: gatewayFixturePid, command: "openclaw-gateway" }],
        hints: [],
      },
      healthy: true,
      staleGatewayPids: [],
      gatewayVersion: "1.0.0",
      waitOutcome: "timeout",
      elapsedMs: 60_000,
    };
    mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expectFailedManagedGitRestart(
      "Gateway responded, but the managed service did not report running after restart.",
    );
  });

  it("fails managed git restart when the stopped service cannot be restarted", async () => {
    mockStoppedManagedGitGateway();
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "default command fixture",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      if (argv[2] === "gateway" && argv[3] === "restart") {
        throw new Error("restart unavailable");
      }
      return runFixtureCommand(argv, options);
    });
    mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expectFailedManagedGitRestart("Gateway: restart failed: Error: restart unavailable");
  });

  it("reports a refused installed restart for an already-stopped Git service", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await setupManagedGitRootRefresh();
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "default command fixture",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) =>
      argv[2] === "gateway" && argv[3] === "restart"
        ? commandResult({ code: 1, stderr: "native owner refused" })
        : runFixtureCommand(argv, options),
    );

    await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

    expect(serviceStop).not.toHaveBeenCalled();
    expect(freshRestartCalls()).toHaveLength(1);
    expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "restart-unhealthy" });
    expect(getErrorOutput()).toContain("native owner refused");
  });

  it("stops a managed gateway rooted at the git checkout when switching package installs to dev", async () => {
    const prefix = createCaseDir("openclaw-update-package-root");
    const { nodeModules } = await setupInstalledPackageAtNodeModules(
      path.join(prefix, "lib", "node_modules"),
    );
    const gitRoot = tempDirs.make("openclaw-update-git-service-root-");
    const sha = "a".repeat(40);
    const serviceEntrypoint = await writeOpenClawPackageFixture(gitRoot, "2026.4.21", {
      entrySource: "export {};\n",
      git: true,
      builtSha: sha,
    });
    const canonicalGitRoot = await fs.realpath(gitRoot);
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, undefined, canonicalGitRoot);
    mockRunningManagedGateway([process.execPath, serviceEntrypoint, "gateway", "run"]);
    // Readiness must identify retained A before stopping it, including its build.
    readPackageVersion.mockResolvedValue("2026.4.21");
    mockGatewayHealth("2026.4.21", "retained-git-A", "fixture-original-build");
    mockGitUpdateAfterMutation(
      makeOkUpdateResult({
        mode: "git",
        root: gitRoot,
        after: { sha, version: "2026.4.21" },
      }),
    );

    await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
      await updateCommand({ channel: "dev", yes: true }).catch((cause: unknown) => {
        throw new Error(getErrorOutput() + getLogOutput(), { cause });
      });
    });

    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(updateGitCheckout).toHaveBeenCalledTimes(1);
    const updateCall = vi.mocked(updateGitCheckout).mock.calls[0]?.[0];
    expect(updateCall?.gitRoot).toBe(canonicalGitRoot);
    expect(updateCall?.opts.beforeGitMutation).toEqual(expect.any(Function));
  });

  it.each(["owned", "foreign"])(
    "uses only the owned profile when switching package installs to dev (%s service)",
    async (serviceOwnership) => {
      const prefix = tempDirs.make("openclaw-update-package-service-root-");
      const nodeModules = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(nodeModules, "openclaw");
      const sha = "a".repeat(40);
      const gitRoot = tempDirs.make("openclaw-update-git-service-root-");
      const packageEntrypoint = await writeOpenClawPackageFixture(packageRoot, "2026.4.20", {
        entrySource: "export {};\n",
      });
      const gitEntrypoint = await writeOpenClawPackageFixture(gitRoot, "2026.4.21", {
        entrySource: "export {};\n",
        git: true,
        builtSha: sha,
      });
      const canonicalGitRoot = await fs.realpath(gitRoot);
      const serviceEntrypoint =
        serviceOwnership === "owned"
          ? packageEntrypoint
          : await writeOpenClawPackageFixture(
              tempDirs.make("openclaw-update-foreign-service-root-"),
              "2026.4.20",
              // A source checkout is not adopted by package-root planning.
              { entrySource: "export {};\n", git: true, builtSha: "b".repeat(40) },
            );
      // The backup owner coalesces by path for the lifetime of the process.
      const callerProfile = `package-git-${serviceOwnership}-caller`;
      const managedProfile = `package-git-${serviceOwnership}-managed`;
      const callerState = profileStateDir(callerProfile);
      const managedState = profileStateDir(managedProfile);
      const callerConfig = path.join(callerState, "openclaw.json");
      const managedConfig = path.join(managedState, "openclaw.json");
      await Promise.all([fs.mkdir(callerState), fs.mkdir(managedState)]);
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: callerState });
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: managedState });
      tempDirsToCleanup.add(callerState);
      tempDirsToCleanup.add(managedState);
      const callerBytes = '{"gateway":{"mode":"local"},"env":{"vars":{"CANARY":"caller"}}}\n';
      const managedBytes = '{"gateway":{"mode":"local"},"env":{"vars":{"CANARY":"managed"}}}\n';
      const existingCallerBackup = "synthetic-previous-caller-backup\n";
      const existingManagedBackup = "synthetic-previous-managed-backup\n";
      await fs.writeFile(callerConfig, callerBytes);
      await fs.writeFile(`${callerConfig}.pre-update`, existingCallerBackup);
      await fs.writeFile(managedConfig, managedBytes);
      await fs.writeFile(`${managedConfig}.pre-update`, existingManagedBackup);
      const managedFilesBefore = await fs.readdir(managedState);
      const selectedConfig = serviceOwnership === "owned" ? managedConfig : callerConfig;
      const { createPreUpdateConfigSnapshot } = await vi.importActual<
        typeof import("../config/backup-rotation.js")
      >("../config/backup-rotation.js");
      createPreUpdateConfigSnapshotMock.mockImplementation(createPreUpdateConfigSnapshot);
      let backupAtDoctorEntry: string | undefined;
      let doctorEnv: NodeJS.ProcessEnv | undefined;
      mockPackageInstallStatus(packageRoot);
      mockFileBackedPathExists();
      mockNpmGlobalCommands(
        nodeModules,
        async (argv, options) => {
          if (argv[2] === "doctor") {
            doctorEnv = typeof options === "number" ? undefined : options.env;
            backupAtDoctorEntry = await fs
              .readFile(`${selectedConfig}.pre-update`, "utf8")
              .catch(() => undefined);
            if (serviceOwnership === "foreign") {
              expect.soft(await fs.readFile(managedConfig, "utf8")).toBe(managedBytes);
              expect
                .soft(await fs.readFile(`${managedConfig}.pre-update`, "utf8"))
                .toBe(existingManagedBackup);
              expect.soft(await fs.readdir(managedState)).toEqual(managedFilesBefore);
            }
          }
          return undefined;
        },
        canonicalGitRoot,
      );
      mockRunningManagedGateway(["node", serviceEntrypoint, "gateway", "run"]);
      mockGatewayHealth("2026.4.21", "updated-checkout");
      serviceReadCommand.mockImplementation(async () => ({
        programArguments: [
          "node",
          gatewayCommandCall(gitEntrypoint, "install") ? gitEntrypoint : serviceEntrypoint,
          "gateway",
          "run",
        ],
        environment: {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          OPENCLAW_PROFILE: managedProfile,
          OPENCLAW_CONFIG_PATH: managedConfig,
          OPENCLAW_STATE_DIR: managedState,
        },
      }));
      const mutationAdmitted = mockGitUpdateAfterMutation(
        makeOkUpdateResult({
          mode: "git",
          root: gitRoot,
          after: { sha, version: "2026.4.21" },
        }),
      );

      await withEnvAsync(
        {
          OPENCLAW_GIT_DIR: gitRoot,
          OPENCLAW_PROFILE: callerProfile,
          OPENCLAW_CONFIG_PATH: callerConfig,
          OPENCLAW_STATE_DIR: callerState,
        },
        async () => {
          await updateCommand({ channel: "dev", yes: true });
          expect(process.env.OPENCLAW_PROFILE).toBe(callerProfile);
          expect(process.env.OPENCLAW_CONFIG_PATH).toBe(callerConfig);
          expect(process.env.OPENCLAW_STATE_DIR).toBe(callerState);
        },
      );

      expect
        .soft({
          OPENCLAW_PROFILE: doctorEnv?.OPENCLAW_PROFILE,
          OPENCLAW_CONFIG_PATH: doctorEnv?.OPENCLAW_CONFIG_PATH,
          OPENCLAW_STATE_DIR: doctorEnv?.OPENCLAW_STATE_DIR,
        })
        .toEqual({
          OPENCLAW_PROFILE: serviceOwnership === "owned" ? managedProfile : callerProfile,
          OPENCLAW_CONFIG_PATH: selectedConfig,
          OPENCLAW_STATE_DIR: serviceOwnership === "owned" ? managedState : callerState,
        });
      expect
        .soft(backupAtDoctorEntry)
        .toBe(serviceOwnership === "owned" ? managedBytes : callerBytes);
      expect.soft(await fs.readFile(callerConfig, "utf8")).toBe(callerBytes);
      expect
        .soft(await fs.readFile(`${callerConfig}.pre-update`, "utf8"))
        .toBe(serviceOwnership === "owned" ? existingCallerBackup : callerBytes);
      expect.soft(await fs.readFile(managedConfig, "utf8")).toBe(managedBytes);
      if (serviceOwnership === "foreign") {
        expect
          .soft(await fs.readFile(`${managedConfig}.pre-update`, "utf8"))
          .toBe(existingManagedBackup);
        expect.soft(await fs.readdir(managedState)).toEqual(managedFilesBefore);
        expect(gatewayCommandCall(gitEntrypoint, "install")).toBeUndefined();
      } else {
        expect(gatewayCommandCall(gitEntrypoint, "install")).toBeDefined();
      }
      expect
        .soft(serviceStop, getErrorOutput() + getLogOutput())
        .toHaveBeenCalledTimes(serviceOwnership === "owned" ? 1 : 0);
      expect.soft(updateGitCheckout).toHaveBeenCalledTimes(1);
      expect.soft(mutationAdmitted).toHaveBeenCalledOnce();
      expect(freshRestartCalls()).toHaveLength(serviceOwnership === "owned" ? 1 : 0);
      expect(defaultRuntime.exit, getErrorOutput() + getLogOutput()).not.toHaveBeenCalledWith(1);
      const updateCall = vi.mocked(updateGitCheckout).mock.calls[0]?.[0];
      expect(updateCall?.gitRoot).toBe(canonicalGitRoot);
      expect(updateCall?.opts.beforeGitMutation).toEqual(expect.any(Function));
    },
  );

  it.runIf(process.platform !== "win32")(
    "continues package-to-Git updates from the published checkout after its alias is retargeted",
    async () => {
      const root = tempDirs.make("openclaw-update-git-alias-");
      const { nodeModules, pkgRoot } = await setupInstalledPackageAtNodeModules(
        path.join(root, "package", "lib", "node_modules"),
      );
      const targetRoot = path.join(root, "checkout-target");
      const replacementRoot = path.join(root, "checkout-replacement");
      const checkoutAlias = path.join(root, "checkout-alias");
      await Promise.all([fs.mkdir(targetRoot), fs.mkdir(replacementRoot)]);
      await fs.symlink(targetRoot, checkoutAlias, "dir");
      const publishedRoot = await fs.realpath(checkoutAlias);
      mockFileBackedPathExists();
      mockNoopPostUpdatePluginConvergence();
      const sha = "a".repeat(40);
      vi.mocked(updateGitCheckout).mockImplementationOnce(
        async ({ gitRoot: stagingRoot, opts: options }) => {
          expect(options.gitArtifactStorageRoot).toBe(path.dirname(stagingRoot));
          await options.inspectGitTarget({});
          await writeOpenClawPackageFixture(stagingRoot, "2026.8.17", {
            git: true,
            builtSha: sha,
            entrySource: "export {};\n",
          });
          await options.prepareGitExposure?.(stagingRoot, sha, undefined);
          await options.validateCandidate(stagingRoot);
          await requireValue(options.beforeGitMutation, "Git mutation admission")({});
          expect(await options.publishGitCheckout?.()).toBe(publishedRoot);
          return makeOkUpdateResult({
            mode: "git",
            root: publishedRoot,
            after: { sha, version: "2026.8.17" },
          });
        },
      );
      mockNpmGlobalCommands(
        nodeModules,
        async (argv) => {
          if (argv[0] === "git" && argv[1] === "clone") {
            const stagingDir = requireValue(argv.at(-1), "Git clone staging directory");
            await writeOpenClawPackageFixture(stagingDir, "2026.8.17", { git: true });
            await fs.unlink(checkoutAlias);
            await fs.symlink(replacementRoot, checkoutAlias, "dir");
          }
        },
        () =>
          requireValue(
            vi.mocked(updateGitCheckout).mock.calls[0]?.[0]?.gitRoot,
            "candidate checkout",
          ),
      );

      await withEnvAsync({ OPENCLAW_GIT_DIR: checkoutAlias }, async () => {
        await updateCommand({ channel: "dev", yes: true, restart: false }).catch(
          (error: unknown) => {
            throw new Error(getErrorOutput() + getLogOutput(), { cause: error });
          },
        );
      });

      const installCall = packageInstallCommandCall();
      const candidateRoot = requireValue(
        vi.mocked(updateGitCheckout).mock.calls[0]?.[0]?.gitRoot,
        "candidate checkout",
      );
      expect(installCall?.[0]).toContain(candidateRoot);
      expect(installCall?.[0]).not.toContain(checkoutAlias);
      expect(installCall?.[1].cwd).toBe(candidateRoot);
      expect(retainUpdateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          installTarget: expect.objectContaining({
            manager: "npm",
            globalRoot: nodeModules,
            packageRoot: pkgRoot,
          }),
          mutationRoots: expect.arrayContaining([pkgRoot, checkoutAlias]),
        }),
      );
      await expect(fs.readdir(replacementRoot)).resolves.toEqual([]);
    },
  );

  it("does not stop an unresolved service when package-to-Git staging fails", async () => {
    const root = tempDirs.make("openclaw-update-package-to-git-unsafe-");
    const packageRoot = path.join(root, ".bun", "install", "global", "node_modules", "openclaw");
    const gitRoot = path.join(root, "git-root");
    const packageEntry = await writeOpenClawPackageFixture(packageRoot, "2026.4.20", {
      entrySource: "export {};\n",
    });
    const sha = "a".repeat(40);
    await writeOpenClawPackageFixture(gitRoot, "2026.8.18", { git: true, builtSha: sha });
    mockPackageInstallStatus(packageRoot);
    resolveGlobalManager.mockResolvedValue("bun");
    mockFileBackedPathExists();
    mockRunningManagedGateway(["node", packageEntry, "gateway", "run"]);
    mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root: gitRoot, after: { sha } }));
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(packageEntry);
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (argv[1] === "add" && argv[2] === "-g") {
        return commandResult({ code: 1, stderr: "candidate install failed" });
      }
      return commandResult();
    });

    await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
      await expect(updateCommand({ channel: "dev", yes: true, json: true })).rejects.toEqual(
        new ExitError(1),
      );
    });

    expect(serviceStop).not.toHaveBeenCalled();
    await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("export {};\n");
    expect(freshRestartCalls()).toEqual([]);
    expectNoSideEffects(serviceStart, serviceRestart, replaceConfigFile);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each(["package", "git"])(
    "leaves the %s service untouched when package-to-Git staging fails",
    async (serviceRoot) => {
      const root = tempDirs.make("openclaw-update-package-to-git-fail-");
      const prefix = path.join(root, "prefix");
      const nodeModules = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(nodeModules, "openclaw");
      const shim = path.join(prefix, "bin", "openclaw");
      const gitRoot = path.join(root, "git-root");
      const sha = "a".repeat(40);
      const packageEntry = await writeOpenClawPackageFixture(packageRoot, "2026.4.20", {
        entrySource: "export {};\n",
        inventory: true,
      });
      await fs.mkdir(path.dirname(shim), { recursive: true });
      await fs.writeFile(shim, "old package shim\n", { mode: 0o755 });
      const gitEntry = await writeOpenClawPackageFixture(gitRoot, "2026.8.18", {
        git: true,
        builtSha: sha,
        entrySource: "export {};\n",
      });
      const packageBefore = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
      const shimBefore = await fs.readFile(shim, "utf8");
      mockPackageInstallStatus(packageRoot);
      mockFileBackedPathExists();
      const serviceEntry = serviceRoot === "git" ? gitEntry : packageEntry;
      mockRunningManagedGateway(["node", serviceEntry, "gateway", "run"]);
      mockGitUpdateAfterMutation(
        makeOkUpdateResult({ mode: "git", root: gitRoot, after: { sha } }),
      );
      mockNpmGlobalCommands(nodeModules, async (argv) => {
        if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
          return commandResult({ code: 1, stderr: "candidate verification fixture failure" });
        }
        return undefined;
      });

      await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
        await expect(updateCommand({ channel: "dev", yes: true, json: true })).rejects.toEqual(
          new ExitError(1),
        );
      });

      const installCalls = commandCalls().filter(
        ([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g",
      );
      expect(installCalls).toHaveLength(2);
      expect(installCalls.every(([argv]) => argv.includes("--prefix"))).toBe(true);
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toBe(
        packageBefore,
      );
      await expect(fs.readFile(shim, "utf8")).resolves.toBe(shimBefore);
      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(serviceStop).not.toHaveBeenCalled();
      expect(freshRestartCalls()).toEqual([]);
      expectNoSideEffects(serviceStart, serviceRestart);
      expect(lastWriteJsonCall()).toMatchObject({
        status: "error",
      });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
    },
  );

  it.each(["package", "git"] as const)(
    "recovers only an untouched package service after source publication fails (service=%s)",
    async (serviceRoot) => {
      const root = tempDirs.make("openclaw-update-source-publish-failure-");
      const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageAtNodeModules(
        path.join(root, "prefix", "lib", "node_modules"),
        "2026.4.20",
      );
      const gitRoot = path.join(root, "git-root");
      const sha = "a".repeat(40);
      const gitEntry = await writeOpenClawPackageFixture(gitRoot, "2026.8.18", {
        git: true,
        builtSha: sha,
        entrySource: "export {};\n",
      });
      mockNpmGlobalCommands(nodeModules, undefined, gitRoot);
      mockFileBackedPathExists();
      mockRunningManagedGateway([
        process.execPath,
        serviceRoot === "package" ? entryPath : gitEntry,
        "gateway",
        "run",
      ]);
      mockGatewayHealth(
        serviceRoot === "package" ? "2026.4.20" : "2026.8.18",
        "previous-gateway",
        serviceRoot === "git" ? "fixture-original-build" : undefined,
      );
      readPackageVersion.mockImplementation(async (packageRoot: string) => {
        const manifest = JSON.parse(
          await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ) as { version: string };
        return manifest.version;
      });
      vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
        await options.prepareGitExposure?.(gitRoot, sha, undefined);
        expect(serviceStop).not.toHaveBeenCalled();
        expect(await fs.realpath(pkgRoot)).toBe(pkgRoot);
        await options.validateCandidate(gitRoot);
        expect(serviceStop).not.toHaveBeenCalled();
        await requireValue(options.beforeGitMutation, "Git mutation admission")({});
        expect(serviceStop).toHaveBeenCalledOnce();
        return makeOkUpdateResult({
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "source-rollback-failed",
          recovery: { serviceRestartSafe: false, reason: "source-rollback-failed" },
        });
      });

      await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
        await expect(updateCommand({ channel: "dev", yes: true, json: true })).rejects.toEqual(
          new ExitError(1),
        );
      });

      expect(candidateValidation).toHaveBeenCalledOnce();
      expect(lastWriteJsonCall()).toMatchObject({ reason: "source-rollback-failed" });
      expect(
        (await fs.readdir(nodeModules)).filter(
          (entry) =>
            entry.startsWith(".openclaw.update-stage-") ||
            entry.startsWith(".openclaw.package-backup-"),
        ).length,
      ).toBe(0);
      expect(doctorCommandCall()).toBeUndefined();
      expect(await fs.realpath(pkgRoot)).toBe(pkgRoot);
      expect(
        JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
      ).toMatchObject({ version: "2026.4.20" });
      if (serviceRoot === "package") {
        expect(freshRestartCalls()).toHaveLength(1);
        expect(freshRestartCalls()[0]?.[0]).toContain(entryPath);
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.4.20" },
        });
      } else {
        expect(freshRestartCalls()).toEqual([]);
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          recovery: { serviceRestartSafe: false, reason: "source-rollback-failed" },
        });
      }
    },
  );

  it("does not stop or restart a managed gateway owned by another git checkout", async () => {
    const otherRoot = tempDirs.make("openclaw-update-other-service-root-");
    const otherEntrypoint = await writeOpenClawPackageFixture(otherRoot, "2026.4.21", {
      entrySource: "export {};\n",
    });
    mockRunningManagedGateway(["node", otherEntrypoint, "gateway", "run"]);
    const mutationAdmitted = mockGitUpdateAfterMutation();

    await updateCommand({ yes: true });

    expectNoSideEffects(serviceStop, serviceRestart, runDaemonRestart);
    expect(updateGitCheckout).toHaveBeenCalledTimes(1);
    expect(mutationAdmitted).toHaveBeenCalledOnce();
    expect(freshRestartCalls()).toHaveLength(0);
    expect(gatewayCommandCall(otherEntrypoint, "install")).toBeUndefined();
  });

  it("never starts the candidate after plugin post-update invalidates config", async () => {
    const serviceEntrypoint = path.join(process.cwd(), "dist", "index.js");
    const invalidPostUpdateSnapshot = configSnapshot(baseConfig, {
      valid: false,
      issues: [{ path: "plugins", message: "invalid plugin config" }],
    });
    syncPluginsForUpdateChannel.mockImplementationOnce(async () => {
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(invalidPostUpdateSnapshot);
      return pluginSyncResult(baseConfig);
    });
    mockRunningManagedGateway(["node", serviceEntrypoint, "gateway", "run"]);
    mockGitUpdateAfterMutation();
    vi.mocked(runExec).mockImplementation(async (_file, args) => {
      if (args[1] === "config" && args[2] === "validate") {
        throw createConfigValidationFailure(
          invalidPostUpdateSnapshot.issues,
          "target plugin config invalid",
        );
      }
      return { stdout: new Date(Date.now() - 1000).toString(), stderr: "" };
    });

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(serviceStop).toHaveBeenCalledTimes(1);
    expectNoSideEffects(serviceRestart, runDaemonRestart);
    expect(freshRestartCalls()).toHaveLength(0);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runExec).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      [serviceEntrypoint, "config", "validate", "--json"],
      expect.objectContaining({ env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" } }),
    );
    expect(getLogOutput()).toContain("OpenClaw update failed: post-update-plugins.");
    expect(getErrorOutput()).not.toContain("Update failed during plugin post-update sync.");
  });

  it("keeps managed service stop output off stdout during json package updates", async () => {
    const tempDir = tempDirs.make("openclaw-update-json-stop-service-");
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockRunningManagedGateway(["node", entryPath, "gateway", "run"]);
    serviceStop.mockImplementationOnce(async (params: { stdout?: NodeJS.WritableStream }) => {
      params.stdout?.write("Stopped systemd service: openclaw-gateway.service\n");
    });
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    let writes;
    try {
      await updateCommand({ yes: true, json: true });
      writes = getMockCallOutput(stdoutWrite);
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(writes).not.toContain("Stopped systemd service");
    expect(serviceStop).toHaveBeenCalled();
  });

  it("disarms legacy launchd updater jobs before stopping the gateway", async () => {
    const tempDir = tempDirs.make("openclaw-update-launchd-loop-");
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    mockRunningManagedGateway(["node", entryPath, "gateway", "run"]);
    launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mockResolvedValue(true);
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    await updateCommand({ yes: true });

    const cleanupOrder =
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mock.invocationCallOrder[0];
    const serviceStopOrder = serviceStop.mock.invocationCallOrder[0];
    expect(requireValue(cleanupOrder, "launchd updater cleanup order")).toBeLessThan(
      requireValue(serviceStopOrder, "service stop order"),
    );
  });
});
