import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { getMockCallOutput } from "./test-runtime-capture.js";
import * as checks from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
import {
  createConfigValidationFailure,
  pluginSyncResult,
} from "./update-cli/update-cli-config.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";
import { createGlobalUserServiceCommand } from "./update-cli/update-command-service-state.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const f = createUpdateCliFixture();

const readText = (file: string) => fs.readFile(file, "utf8");
const expectText = (file: string) => expect(readText(file)).resolves;
const manifest = (root: string) => path.join(root, "package.json");
const gatewayArgs = (entry: string) => ["node", entry, "gateway", "run"];
const devUpdate = (root: string, options: Parameters<typeof cli.updateCommand>[0] = {}) =>
  withEnvAsync({ OPENCLAW_GIT_DIR: root }, () =>
    cli.updateCommand({ channel: "dev", yes: true, ...options }),
  );
const expectFailure = (updating: Promise<unknown>) =>
  expect(updating).rejects.toEqual(new cli.ExitError(1));
const packageFixture = (root: string, version: string, git = false, builtSha?: string) =>
  writeOpenClawPackageFixture(root, version, { entrySource: "export {};\n", git, builtSha });
async function createProfile(profile: string) {
  const state = f.profileStateDir(profile);
  const env = { ...process.env, OPENCLAW_STATE_DIR: state };
  f.initializeExistingUpdateProfile(env);
  f.tempDirsToCleanup.add(state);
  await fs.mkdir(state, { recursive: true });
  return { state, config: path.join(state, "openclaw.json"), env };
}
async function storedProfile(name: string, label: string) {
  const profile = await createProfile(name);
  const bytes =
    JSON.stringify({ gateway: { mode: "local" }, env: { vars: { CANARY: label } } }) + "\n";
  const backup = `synthetic-previous-${label}-backup\n`;
  await fs.writeFile(profile.config, bytes);
  await fs.writeFile(`${profile.config}.pre-update`, backup);
  return {
    ...profile,
    bytes,
    backup,
    selector: {
      OPENCLAW_PROFILE: name,
      OPENCLAW_CONFIG_PATH: profile.config,
      OPENCLAW_STATE_DIR: profile.state,
    },
  };
}
async function expectStoredProfile(
  profile: Awaited<ReturnType<typeof storedProfile>>,
  backup = profile.backup,
) {
  expect.soft(await readText(profile.config)).toBe(profile.bytes);
  expect.soft(await readText(`${profile.config}.pre-update`)).toBe(backup);
}
const stringEnvironment = (env: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

it.each(["owned", "unresolved"] as const)(
  "inspects an %s service wrapper when openclaw is absent from PATH",
  async (ownership) => {
    const root = f.createCaseDir("openclaw-update-wrapper-install");
    const entrypoint = await packageFixture(root, "1.0.0", true);
    vi.mocked(cli.resolveOpenClawPackageRoot).mockResolvedValue(root);
    f.mockFileBackedPathExists();
    const wrapperDir =
      ownership === "owned"
        ? path.join(root, "bin")
        : f.createCaseDir("openclaw-update-wrapper-service");
    const wrapperPath = path.join(wrapperDir, "gateway-wrapper");
    await fs.mkdir(wrapperDir, { recursive: true });
    await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const { state: stateDir, config: configPath, env } = await createProfile("wrapper-service");
    openOpenClawStateDatabase({ env });
    await fs.writeFile(configPath, JSON.stringify(f.baseSnapshot.config));
    const serviceEnv = {
      ...process.env,
      OPENCLAW_PROFILE: "wrapper-service",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WRAPPER: wrapperPath,
      PATH: path.dirname(process.execPath),
    };
    const { buildGatewayInstallPlan } = await import("../commands/daemon-install-helpers.js");
    const planOptions = {
      config: f.baseSnapshot.config,
      port: 18789,
      runtime: "node" as const,
      wrapperPath,
    };
    const initialPlan = await buildGatewayInstallPlan({
      ...planOptions,
      env: serviceEnv,
      runtimePath: process.execPath,
    });
    // A real LaunchAgent install creates this directory before the service runs.
    await fs.mkdir(
      checks.requireValue(initialPlan.environment.TMPDIR, "managed service temp directory"),
      { recursive: true, mode: 0o700 },
    );
    const existingEnvironment = stringEnvironment(initialPlan.environment);
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
      ...planOptions,
      env: installEnv,
      existingEnvironment,
      existingEnvironmentValueSources: initialPlan.environmentValueSources,
    });
    const serviceCommand = {
      ...servicePlan,
      environment: {
        ...stringEnvironment(servicePlan.environment),
        // This sealed service deliberately has no CLI on PATH, including host-wide installs.
        PATH: wrapperDir,
      },
    };
    mocks.serviceReadCommand.mockResolvedValue(serviceCommand);
    mocks.serviceLoaded.mockResolvedValue(true);
    mocks.serviceReadRuntime.mockImplementation(async () =>
      mocks.serviceStop.mock.calls.length === 0 || checks.freshRestartCalls().length > 0
        ? { status: "running", pid: mocks.gatewayFixturePid, state: "running" }
        : { status: "stopped", pid: null, state: "stopped" },
    );
    mocks.serviceDefinitionMutationCapability.mockResolvedValue({
      kind: "sealed",
      detail: "privileged wrapper owner",
    });
    const { resolveExecutablePath } = await import("../infra/executable-path.js");
    expect(resolveExecutablePath("openclaw", { env: serviceCommand.environment })).toBeUndefined();
    const envSnapshot = captureEnv(Object.keys(serviceCommand.environment));
    cli.mockGitUpdateAfterMutation(cli.makeOkUpdateResult({ mode: "git", root }));
    vi.mocked(cli.resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);

    try {
      await cli.updateCommand({ yes: true });
    } finally {
      envSnapshot.restore();
      const { clearConfigCache } = await import("../config/io.js");
      const { clearRuntimeConfigSnapshot } = await import("../config/runtime-snapshot.js");
      clearConfigCache();
      clearRuntimeConfigSnapshot();
    }

    if (ownership === "unresolved") {
      expect(checks.getLogOutput()).toContain("Stop the Gateway through its owner");
      expect(cli.updateGitCheckout).toHaveBeenCalledOnce();
      checks.expectNoSideEffects(
        mocks.serviceStop,
        mocks.serviceStart,
        mocks.serviceRestart,
        cli.runDaemonInstall,
        cli.runDaemonRestart,
      );
      expect(checks.freshRestartCalls()).toHaveLength(0);
      return;
    }
    expect(checks.getErrorOutput()).toContain("service definition left unchanged");
    expect(mocks.serviceStop).toHaveBeenCalledTimes(1);
    expect(cli.updateGitCheckout).toHaveBeenCalledTimes(1);
    const restartOptions = checks.freshRestartCalls()[0]?.[1];
    expect(typeof restartOptions === "object" && restartOptions.env?.OPENCLAW_WRAPPER).toBe(
      wrapperPath,
    );
    expect(mocks.serviceStart).not.toHaveBeenCalled();
    checks.expectNoSideEffects(cli.runDaemonInstall, cli.runDaemonRestart);
  },
);

it.each(["stopped", "throws", "refused"] as const)(
  "reports managed Git restart failure: %s",
  async (failure) => {
    if (failure === "refused") {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      await f.setupManagedGitRootRefresh();
      mocks.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    } else {
      f.mockStoppedManagedGitGateway();
      cli.mockGitUpdateAfterMutation(cli.makeOkUpdateResult({ root: process.cwd() }));
    }
    if (failure === "stopped") {
      mocks.restartHealthTestControl.snapshot = {
        runtime: { status: "stopped", pid: null, state: "stopped" },
        portUsage: {
          port: 18789,
          status: "busy",
          listeners: [{ pid: mocks.gatewayFixturePid, command: "openclaw-gateway" }],
          hints: [],
        },
        healthy: true,
        staleGatewayPids: [],
        gatewayVersion: "1.0.0",
        waitOutcome: "timeout",
        elapsedMs: 60_000,
      };
    } else {
      const runFixtureCommand = checks.requireValue(
        vi.mocked(cli.runCommandWithTimeout).getMockImplementation(),
        "default command fixture",
      );
      vi.mocked(cli.runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[2] === "gateway" && argv[3] === "restart") {
          if (failure === "throws") {
            throw new Error("restart unavailable");
          }
          return commandResult({ code: 1, stderr: "native owner refused" });
        }
        return runFixtureCommand(argv, options);
      });
    }

    await expectFailure(cli.updateCommand({ yes: true, json: failure === "refused" }));

    if (failure === "refused") {
      expect(mocks.serviceStop).not.toHaveBeenCalled();
      expect(checks.freshRestartCalls()).toHaveLength(1);
      expect(checks.lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "restart-unhealthy",
      });
      expect(checks.getErrorOutput()).toContain("native owner refused");
    } else {
      f.expectFailedManagedGitRestart(
        failure === "stopped"
          ? "Managed Gateway service status: stopped."
          : "Gateway: restart failed: Error: restart unavailable",
      );
    }
  },
);

it.each(["owned", "foreign"])(
  "uses only the owned profile when switching package installs to dev (%s service)",
  async (serviceOwnership) => {
    const owned = serviceOwnership === "owned";
    const prefix = f.tempDirs.make("openclaw-update-package-service-root-");
    const nodeModules = path.join(prefix, "lib", "node_modules");
    const packageRoot = path.join(nodeModules, "openclaw");
    const sha = "a".repeat(40);
    const gitRoot = f.tempDirs.make("openclaw-update-git-service-root-");
    const packageEntrypoint = await packageFixture(packageRoot, "2026.4.20");
    const gitEntrypoint = await packageFixture(gitRoot, "2026.4.21", true, sha);
    const canonicalGitRoot = await fs.realpath(gitRoot);
    const serviceEntrypoint = owned
      ? packageEntrypoint
      : await packageFixture(
          f.tempDirs.make("openclaw-update-foreign-service-root-"),
          "2026.4.20",
          // A source checkout is not adopted by package-root planning.
          true,
          "b".repeat(40),
        );
    // The backup owner coalesces by path for the lifetime of the process.
    const caller = await storedProfile(`package-git-${serviceOwnership}-caller`, "caller");
    const managed = await storedProfile(`package-git-${serviceOwnership}-managed`, "managed");
    const selected = owned ? managed : caller;
    openOpenClawStateDatabase({ env: selected.env });
    const managedFilesBefore = await fs.readdir(managed.state);
    const { createPreUpdateConfigSnapshot } = await vi.importActual<
      typeof import("../config/backup-rotation.js")
    >("../config/backup-rotation.js");
    mocks.createPreUpdateConfigSnapshotMock.mockImplementation(createPreUpdateConfigSnapshot);
    let backupAtDoctorEntry: string | undefined;
    let doctorEnv: NodeJS.ProcessEnv | undefined;
    f.mockPackageInstallStatus(packageRoot);
    f.mockFileBackedPathExists();
    f.mockNpmGlobalCommands(
      nodeModules,
      async (argv, options) => {
        if (argv[2] === "doctor") {
          doctorEnv = typeof options === "number" ? undefined : options.env;
          backupAtDoctorEntry = await fs
            .readFile(`${selected.config}.pre-update`, "utf8")
            .catch(() => undefined);
          if (!owned) {
            await expectStoredProfile(managed);
            expect.soft(await fs.readdir(managed.state)).toEqual(managedFilesBefore);
          }
        }
        return undefined;
      },
      canonicalGitRoot,
    );
    f.mockRunningManagedGateway(gatewayArgs(serviceEntrypoint));
    f.mockGatewayHealth("2026.4.21", "updated-checkout");
    mocks.serviceReadCommand.mockImplementation(async () => ({
      programArguments: gatewayArgs(
        checks.gatewayCommandCall(gitEntrypoint, "install") ? gitEntrypoint : serviceEntrypoint,
      ),
      environment: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        ...managed.selector,
      },
    }));
    const mutationAdmitted = cli.mockGitUpdateAfterMutation(
      cli.makeOkUpdateResult({ mode: "git", root: gitRoot, after: { sha, version: "2026.4.21" } }),
    );

    await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot, ...caller.selector }, async () => {
      await cli.updateCommand({ channel: "dev", yes: true });
      expect(process.env).toMatchObject(caller.selector);
    });

    expect.soft(doctorEnv).toMatchObject(selected.selector);
    expect.soft(backupAtDoctorEntry).toBe(selected.bytes);
    await expectStoredProfile(caller, owned ? caller.backup : caller.bytes);
    expect.soft(await readText(managed.config)).toBe(managed.bytes);
    if (!owned) {
      await expectStoredProfile(managed);
      expect.soft(await fs.readdir(managed.state)).toEqual(managedFilesBefore);
      expect(checks.gatewayCommandCall(gitEntrypoint, "install")).toBeUndefined();
    } else {
      expect(checks.gatewayCommandCall(gitEntrypoint, "install")).toBeDefined();
    }
    expect
      .soft(mocks.serviceStop, checks.getErrorOutput() + checks.getLogOutput())
      .toHaveBeenCalledTimes(owned ? 1 : 0);
    expect.soft(cli.updateGitCheckout).toHaveBeenCalledTimes(1);
    expect.soft(mutationAdmitted).toHaveBeenCalledOnce();
    expect(checks.freshRestartCalls()).toHaveLength(owned ? 1 : 0);
    expect(
      cli.defaultRuntime.exit,
      checks.getErrorOutput() + checks.getLogOutput(),
    ).not.toHaveBeenCalledWith(1);
    const updateCall = vi.mocked(cli.updateGitCheckout).mock.calls[0]?.[0];
    expect(updateCall?.gitRoot).toBe(canonicalGitRoot);
    expect(updateCall?.opts.beforeGitMutation).toEqual(expect.any(Function));
  },
);

it.runIf(process.platform !== "win32")(
  "continues package-to-Git updates from the published checkout after its alias is retargeted",
  async () => {
    const root = f.tempDirs.make("openclaw-update-git-alias-");
    const { nodeModules, pkgRoot } = await f.setupInstalledPackageAtNodeModules(
      path.join(root, "package", "lib", "node_modules"),
    );
    const targetRoot = path.join(root, "checkout-target");
    const replacementRoot = path.join(root, "checkout-replacement");
    const checkoutAlias = path.join(root, "checkout-alias");
    await Promise.all([fs.mkdir(targetRoot), fs.mkdir(replacementRoot)]);
    await fs.symlink(targetRoot, checkoutAlias, "dir");
    const publishedRoot = await fs.realpath(checkoutAlias);
    f.mockFileBackedPathExists();
    f.mockNoopPostUpdatePluginConvergence();
    const sha = "a".repeat(40);
    vi.mocked(cli.updateGitCheckout).mockImplementationOnce(
      async ({ gitRoot: stagingRoot, opts: options }) => {
        expect(options.gitArtifactStorageRoot).toBe(path.dirname(stagingRoot));
        await options.inspectGitTarget({});
        await packageFixture(stagingRoot, "2026.8.17", true, sha);
        await options.prepareGitExposure?.(stagingRoot, sha, undefined);
        await options.validateCandidate(stagingRoot);
        await checks.requireValue(options.beforeGitMutation, "Git mutation admission")({});
        expect(await options.publishGitCheckout?.()).toBe(publishedRoot);
        return cli.makeOkUpdateResult({
          mode: "git",
          root: publishedRoot,
          after: { sha, version: "2026.8.17" },
        });
      },
    );
    f.mockNpmGlobalCommands(
      nodeModules,
      async (argv) => {
        if (argv[0] === "git" && argv[1] === "clone") {
          const stagingDir = checks.requireValue(argv.at(-1), "Git clone staging directory");
          await writeOpenClawPackageFixture(stagingDir, "2026.8.17", { git: true });
          await fs.unlink(checkoutAlias);
          await fs.symlink(replacementRoot, checkoutAlias, "dir");
        }
      },
      () =>
        checks.requireValue(
          vi.mocked(cli.updateGitCheckout).mock.calls[0]?.[0]?.gitRoot,
          "candidate checkout",
        ),
    );

    await devUpdate(checkoutAlias, { restart: false }).catch((error: unknown) => {
      throw new Error(checks.getErrorOutput() + checks.getLogOutput(), { cause: error });
    });

    const installCall = checks.packageInstallCommandCall();
    const candidateRoot = checks.requireValue(
      vi.mocked(cli.updateGitCheckout).mock.calls[0]?.[0]?.gitRoot,
      "candidate checkout",
    );
    expect(installCall?.[0]).toContain(candidateRoot);
    expect(installCall?.[0]).not.toContain(checkoutAlias);
    expect(installCall?.[1].cwd).toBe(candidateRoot);
    expect(mocks.retainUpdateRuntime).toHaveBeenCalledWith(
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

it("leaves the git service untouched when package-to-Git staging fails", async () => {
  const root = f.tempDirs.make("openclaw-update-package-to-git-fail-");
  const prefix = path.join(root, "prefix");
  const nodeModules = path.join(prefix, "lib", "node_modules");
  const { pkgRoot: packageRoot } = await f.setupInstalledPackageAtNodeModules(
    nodeModules,
    "2026.4.20",
  );
  const shim = path.join(prefix, "bin", "openclaw");
  const gitRoot = path.join(root, "git-root");
  const sha = "a".repeat(40);
  await fs.mkdir(path.dirname(shim), { recursive: true });
  await fs.writeFile(shim, "old package shim\n", { mode: 0o755 });
  const gitEntry = await packageFixture(gitRoot, "2026.8.18", true, sha);
  const packageBefore = await readText(manifest(packageRoot));
  const shimBefore = await readText(shim);
  f.mockFileBackedPathExists();
  f.mockRunningManagedGateway(gatewayArgs(gitEntry));
  cli.mockGitUpdateAfterMutation(
    cli.makeOkUpdateResult({ mode: "git", root: gitRoot, after: { sha } }),
  );
  f.mockNpmGlobalCommands(nodeModules, async (argv) => {
    if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
      return commandResult({ code: 1, stderr: "candidate verification fixture failure" });
    }
    return undefined;
  });

  await expectFailure(devUpdate(gitRoot, { json: true }));

  const installCalls = checks
    .commandCalls()
    .filter(([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");
  expect(installCalls).toHaveLength(2);
  expect(installCalls.every(([argv]) => argv.includes("--prefix"))).toBe(true);
  await expectText(manifest(packageRoot)).toBe(packageBefore);
  await expectText(shim).toBe(shimBefore);
  checks.expectNoSideEffects(
    cli.replaceConfigFile,
    mocks.serviceStop,
    mocks.serviceStart,
    mocks.serviceRestart,
  );
  expect(checks.freshRestartCalls()).toEqual([]);
  expect(checks.lastWriteJsonCall()).toMatchObject({ status: "error" });
  expect(cli.defaultRuntime.exit).not.toHaveBeenCalled();
});

it("recovers only an untouched package service after source publication fails", async () => {
  const root = f.tempDirs.make("openclaw-update-source-publish-failure-");
  const { nodeModules, pkgRoot, entryPath } = await f.setupInstalledPackageAtNodeModules(
    path.join(root, "prefix", "lib", "node_modules"),
    "2026.4.20",
  );
  const gitRoot = path.join(root, "git-root");
  const sha = "a".repeat(40);
  await packageFixture(gitRoot, "2026.8.18", true, sha);
  f.mockNpmGlobalCommands(nodeModules, undefined, gitRoot);
  f.mockFileBackedPathExists();
  f.mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
  f.mockGatewayHealth("2026.4.20", "previous-gateway", undefined);
  mocks.readPackageVersion.mockImplementation(async (packageRoot: string) => {
    const pkg: { version: string } = JSON.parse(await readText(manifest(packageRoot)));
    return pkg.version;
  });
  vi.mocked(cli.updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
    await options.prepareGitExposure?.(gitRoot, sha, undefined);
    expect(mocks.serviceStop).not.toHaveBeenCalled();
    expect(await fs.realpath(pkgRoot)).toBe(pkgRoot);
    await options.validateCandidate(gitRoot);
    expect(mocks.serviceStop).not.toHaveBeenCalled();
    await checks.requireValue(options.beforeGitMutation, "Git mutation admission")({});
    expect(mocks.serviceStop).toHaveBeenCalledOnce();
    return cli.makeOkUpdateResult({
      status: "error",
      mode: "git",
      root: gitRoot,
      reason: "source-rollback-failed",
      recovery: { serviceRestartSafe: false, reason: "source-rollback-failed" },
    });
  });

  await expectFailure(devUpdate(gitRoot, { json: true }));

  expect(mocks.candidateValidation).toHaveBeenCalledOnce();
  expect(
    (await fs.readdir(nodeModules)).filter(
      (entry) =>
        entry.startsWith(".openclaw.update-stage-") ||
        entry.startsWith(".openclaw.package-backup-"),
    ),
  ).toEqual([]);
  expect(checks.doctorCommandCall()).toBeUndefined();
  expect(await fs.realpath(pkgRoot)).toBe(pkgRoot);
  expect(JSON.parse(await readText(manifest(pkgRoot)))).toMatchObject({ version: "2026.4.20" });

  expect(checks.freshRestartCalls()).toHaveLength(1);
  expect(checks.freshRestartCalls()[0]?.[0]).toContain(entryPath);
  expect(checks.lastWriteJsonCall()).toMatchObject({
    reason: "source-rollback-failed",
    status: "error",
    recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.4.20" },
  });
});

it("never starts the candidate after plugin post-update invalidates config", async () => {
  const packageManifest = manifest(process.cwd());
  const originalManifest = await fs.readFile(packageManifest);
  onTestFinished(() => fs.writeFile(packageManifest, originalManifest));
  const previousVersion = "1.0.0";
  const serviceEntrypoint = await packageFixture(process.cwd(), previousVersion, true);
  const runtimeDirectory = path.dirname(serviceEntrypoint);
  const previousRuntimeSource = "export const previousFixtureRuntime = true;\n";
  f.tempDirsToCleanup.add(runtimeDirectory);
  await fs.writeFile(serviceEntrypoint, previousRuntimeSource);
  const previousRuntime = await fs.stat(runtimeDirectory);
  const activateGateway = f.mockPackageGatewayLifecycle();
  const restartedRuntimes: { dev: number; ino: number; source: string }[] = [];
  const runFixtureCommand = checks.requireValue(
    vi.mocked(cli.runCommandWithTimeout).getMockImplementation(),
    "default command fixture",
  );
  vi.mocked(cli.runCommandWithTimeout).mockImplementation(async (argv, options) => {
    if (argv[2] === "gateway" && argv[3] === "restart") {
      const runtime = await fs.stat(runtimeDirectory);
      restartedRuntimes.push({
        dev: runtime.dev,
        ino: runtime.ino,
        source: await fs.readFile(serviceEntrypoint, "utf8"),
      });
    }
    await activateGateway(argv);
    return runFixtureCommand(argv, options);
  });
  await f.useFileBackedConfig();
  const invalidPostUpdateSnapshot = {
    ...(await cli.readConfigFileSnapshot()),
    valid: false,
    issues: [{ path: "plugins", message: "invalid plugin config" }],
  };
  mocks.syncPluginsForUpdateChannel.mockImplementationOnce(async () => {
    vi.mocked(cli.readConfigFileSnapshot).mockResolvedValue(invalidPostUpdateSnapshot);
    return pluginSyncResult(f.baseConfig);
  });
  f.mockRunningManagedGateway(gatewayArgs(serviceEntrypoint));
  f.mockGatewayHealth(previousVersion, "previous-fixture-gateway");
  cli.mockGitUpdateAfterMutation(
    cli.makeOkUpdateResult({
      root: process.cwd(),
      before: { version: previousVersion },
      after: { version: previousVersion },
    }),
  );
  vi.mocked(cli.runExec).mockImplementation(async (_file, args) => {
    if (args[1] === "config" && args[2] === "validate") {
      throw createConfigValidationFailure(
        invalidPostUpdateSnapshot.issues,
        "target plugin config invalid",
      );
    }
    return { stdout: new Date(Date.now() - 1000).toString(), stderr: "" };
  });

  await expectFailure(cli.updateCommand({ yes: true }));

  expect(mocks.serviceStop).toHaveBeenCalledTimes(1);
  checks.expectNoSideEffects(mocks.serviceRestart, cli.runDaemonRestart);
  // A recovery restart must use the original directory restored by the retained
  // transaction; matching script bytes alone cannot identify its generation.
  expect(restartedRuntimes, checks.getLogOutput()).toEqual([
    { dev: previousRuntime.dev, ino: previousRuntime.ino, source: previousRuntimeSource },
  ]);
  expect(checks.freshRestartCalls()).toHaveLength(1);
  expect(cli.defaultRuntime.exit).not.toHaveBeenCalled();
  expect(cli.runExec).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    [serviceEntrypoint, "config", "validate", "--json"],
    expect.objectContaining({ env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" } }),
  );
  expect(checks.getLogOutput()).toContain(
    `OpenClaw update rolled back to ${previousVersion}: post-update-plugins.`,
  );
  expect(checks.getLogOutput()).toContain("invalid plugin config");
  expect(checks.getErrorOutput()).not.toContain("Update failed during plugin post-update sync.");
});

it("disarms legacy updater jobs before stopping the gateway without polluting JSON stdout", async () => {
  const tempDir = f.tempDirs.make("openclaw-update-json-stop-service-");
  const { nodeModules, entryPath } = await f.setupInstalledPackageRoot(tempDir);
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  f.mockRunningManagedGateway(gatewayArgs(entryPath));
  mocks.serviceStop.mockImplementationOnce(async (params: { stdout?: NodeJS.WritableStream }) => {
    params.stdout?.write("Stopped systemd service: openclaw-gateway.service\n");
  });
  mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mockResolvedValue(true);
  f.mockFileBackedPathExists();
  f.mockNpmGlobalRoot(nodeModules);

  await cli.updateCommand({ yes: true, json: true });
  const writes = getMockCallOutput(stdoutWrite);

  expect(writes).not.toContain("Stopped systemd service");
  expect(mocks.serviceStop).toHaveBeenCalled();
  const cleanupOrder =
    mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mock
      .invocationCallOrder[0];
  const serviceStopOrder = mocks.serviceStop.mock.invocationCallOrder[0];
  expect(checks.requireValue(cleanupOrder, "launchd updater cleanup order")).toBeLessThan(
    checks.requireValue(serviceStopOrder, "service stop order"),
  );
});

it("uses a manager-effective global user unit during update preflight", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const entrypoint = path.join(process.cwd(), "dist", "index.js");
  const command = createGlobalUserServiceCommand(entrypoint);
  f.mockRunningManagedGateway(gatewayArgs(entrypoint));
  mocks.serviceReadCommand.mockImplementation(async (_env, options) =>
    options?.requireEffective ? command : null,
  );
  mocks.serviceDefinitionMutationCapability.mockResolvedValue({
    kind: "sealed",
    detail: "privileged global user unit",
  });
  vi.mocked(cli.resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
  cli.mockGitUpdateAfterMutation(cli.makeOkUpdateResult({ mode: "git", root: process.cwd() }));

  await cli.updateCommand({ yes: true });

  expect(mocks.serviceStop.mock.calls.length).toBe(1);
  expect(vi.mocked(cli.runDaemonInstall).mock.calls.length).toBe(0);
});
