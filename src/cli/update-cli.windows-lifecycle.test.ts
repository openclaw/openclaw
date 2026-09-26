import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import {
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  gatewayFixturePid,
  restartHealthTestControl,
  resumeScheduledTaskAutoStartAfterUpdate,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStop,
  suspendScheduledTaskAutoStartForUpdate,
  triageCommand,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  expectSelectorTriageFailure,
  fetchNpmPackageTargetStatus,
  invokeUpdateCli,
  listUpdateRuns,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveUpdateInstallIdentity,
  resolveUpdateInstallKind,
  runCommandWithTimeout,
  runDaemonInstall,
  runDaemonRestart,
  runUpdateFailureTriage,
  updateCommand,
  updateFinalizeCommand,
} from "./update-cli-modules.test-support.js";
import {
  recoveryVerificationStep,
  registerFailureSelectorTests,
} from "./update-cli/update-cli-failure-recovery.test-support.js";
import { writeJsonFixture } from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseSnapshot,
    initializeExistingUpdateProfile,
    mockFileBackedPathExists,
    mockGatewayHealth,
    mockNpmGlobalRoot,
    mockPackageInstallAtCaseDir,
    mockRunningManagedGateway,
    primeServiceCommand,
    profileStateDir,
    setStdoutTty,
    setTty,
    setupInstalledPackageRoot,
    tempDirs,
    tempDirsToCleanup,
    useFileBackedConfig,
    useNativeScheduledTaskControl,
  } = createUpdateCliFixture();

  registerFailureSelectorTests({
    updateCommand,
    updateFinalizeCommand,
    readConfigFileSnapshot,
    profileStateDir,
    runUpdateFailureTriage,
    expectSelectorTriageFailure,
  });

  it("does not inspect or mutate a Windows host service from an isolated install", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDir = tempDirs.make("openclaw-update-isolated-service-");
    const { nodeModules } = await setupInstalledPackageRoot(tempDir);
    mockRunningManagedGateway();
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    await withEnvAsync({ OPENCLAW_HOME: path.join(tempDir, "relocated-home") }, async () => {
      initializeExistingUpdateProfile();
      await updateCommand({ yes: true });
    });
    platformSpy.mockRestore();

    expect(serviceReadCommand).not.toHaveBeenCalled();
    expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(freshRestartCalls()).toHaveLength(0);
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeDefined();
  });

  it.each([
    {
      platform: "darwin" as const,
      envKey: "OPENCLAW_LAUNCHD_LABEL",
      value: "ai.openclaw.gateway",
    },
    {
      platform: "linux" as const,
      envKey: "OPENCLAW_SYSTEMD_UNIT",
      value: "openclaw-gateway.service",
    },
    {
      platform: "win32" as const,
      envKey: "OPENCLAW_WINDOWS_TASK_NAME",
      value: "OpenClaw Gateway",
    },
  ])(
    "does not reuse a conflicting $envKey selector from the managed service on $platform",
    async ({ platform, envKey, value }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const tempDir = tempDirs.make(`openclaw-update-${platform}-selector-`);
      const home = path.join(tempDir, "home");
      const stateDir = path.join(home, ".openclaw-work");
      const { nodeModules, pkgRoot: root } = await setupInstalledPackageRoot(tempDir);
      serviceReadCommand.mockResolvedValue({
        programArguments: ["node", path.join(root, "dist", "index.js"), "gateway", "run"],
        environment: {
          OPENCLAW_PROFILE: "work",
          [envKey]: value,
        },
      });
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      mockFileBackedPathExists();
      mockNpmGlobalRoot(nodeModules);

      try {
        await withEnvAsync(
          {
            HOME: home,
            USERPROFILE: undefined,
            OPENCLAW_HOME: undefined,
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
            [envKey]: undefined,
          },
          async () => {
            await expect(invokeUpdateCli({ yes: true })).rejects.toEqual(new ExitError(1));
          },
        );
      } finally {
        platformSpy.mockRestore();
      }

      expect(serviceReadRuntime).not.toHaveBeenCalled();
      expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
      expect(serviceStop).not.toHaveBeenCalled();
      expect(serviceRestart).not.toHaveBeenCalled();
      expect(freshRestartCalls()).toHaveLength(0);
      expect(runDaemonRestart).not.toHaveBeenCalled();
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(getLogOutput()).toContain(envKey);
      expect(fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
      for (const candidateState of [stateDir, path.join(home, ".openclaw")]) {
        expect(
          fsSync.existsSync(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: candidateState })),
        ).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "recovers a failed managed service stop only after an observed mutation (%s)",
    async (mutated) => {
      const root = await mockPackageInstallAtCaseDir("openclaw-update-partial-stop");
      mockFileBackedPathExists();
      const entrypoints = await vi.importActual<typeof import("../daemon/gateway-entrypoint.js")>(
        "../daemon/gateway-entrypoint.js",
      );
      // A failed stop never reaches package Doctor or the fresh-process decision.
      vi.mocked(resolveGatewayInstallEntrypoint)
        .mockReset()
        .mockImplementation(entrypoints.resolveGatewayInstallEntrypoint);
      mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
      serviceStop.mockImplementationOnce(async ({ onMutation }) => {
        if (mutated) {
          onMutation?.({ mode: "bootout" });
        }
        throw new Error(mutated ? "port still busy after bootout" : "bootout refused");
      });

      await expect(invokeUpdateCli({ channel: "beta", yes: true, json: true })).rejects.toEqual(
        new ExitError(1),
      );

      expect(serviceStop).toHaveBeenCalledOnce();
      expect(freshRestartCalls(), getErrorOutput()).toHaveLength(mutated ? 1 : 0);
      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "managed-service-stop-failed",
        recovery: { serviceRestartSafe: true },
      });
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
        version: "1.0.0",
      });
    },
  );

  it("restores Windows Scheduled Task autostart when service stop fails", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const root = await mockPackageInstallAtCaseDir("openclaw-update-stop-failure");
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    serviceStop.mockRejectedValueOnce(new Error("stop failed"));
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);

    await expect(invokeUpdateCli({ yes: true })).rejects.toEqual(new ExitError(1));
    platformSpy.mockRestore();

    expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledTimes(1);
    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledTimes(1);
    expect(packageInstallCommandCall()).toBeDefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    const suspendOrder = suspendScheduledTaskAutoStartForUpdate.mock.invocationCallOrder[0];
    const stopOrder = serviceStop.mock.invocationCallOrder[0];
    const resumeOrder = resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0];
    expect(requireValue(suspendOrder, "Scheduled Task suspend order")).toBeLessThan(
      requireValue(stopOrder, "service stop order"),
    );
    expect(requireValue(stopOrder, "service stop order")).toBeLessThan(
      requireValue(resumeOrder, "Scheduled Task resume order"),
    );
  });

  it.each([
    { command: "update", fault: "stop" },
    { command: "doctor", fault: "stop" },
    { command: "update", fault: "stop-enable-committed" },
    { command: "doctor", fault: "stop-enable-committed" },
    { command: "update", fault: "suspension" },
    { command: "doctor", fault: "suspension" },
    { command: "update", fault: "suspension-spawn" },
    { command: "doctor", fault: "suspension-spawn" },
  ] as const)(
    "starts $command triage when native $fault preparation cannot restore task autostart",
    async ({ command, fault }) => {
      const stopFailure = fault === "stop" || fault === "stop-enable-committed";
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      setTty(true);
      setStdoutTty(true);
      const root = await mockPackageInstallAtCaseDir("openclaw-update-native-preparation");
      if (command === "doctor") {
        vi.mocked(resolveUpdateInstallKind).mockResolvedValue("git");
        vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "git" });
      }
      mockRunningManagedGateway([
        process.execPath,
        path.join(root, "dist", "entry.js"),
        "gateway",
        "run",
      ]);
      mockFileBackedPathExists();
      const target = {
        stateDir: profileStateDir("native-preparation"),
        configPath: path.join(profileStateDir("native-preparation"), "openclaw.json"),
        defaultWorkspaceDir: path.join(profileStateDir("native-preparation"), "workspace"),
      };
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: target.stateDir });
      tempDirsToCleanup.add(target.stateDir);
      await fs.mkdir(target.stateDir, { recursive: true });
      await writeJsonFixture(target.configPath, baseSnapshot.config);
      primeServiceCommand(
        [process.execPath, path.join(root, "dist", "entry.js"), "gateway", "run"],
        {
          OPENCLAW_PROFILE: "native-preparation",
          OPENCLAW_STATE_DIR: target.stateDir,
          OPENCLAW_CONFIG_PATH: target.configPath,
          OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
        },
        path.join(target.stateDir, "gateway.cmd"),
      );
      await useNativeScheduledTaskControl();
      const configuredRunCommand = vi.mocked(runCommandWithTimeout).getMockImplementation();
      if (!configuredRunCommand) {
        throw new Error("Expected installed package command fixture");
      }
      let taskEnabled = true;
      const nativeCommands: string[][] = [];
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[0] === "git" && argv[3] === "rev-parse") {
          return commandResult({ stdout: `${root}\n` });
        }
        if (argv[0] !== "schtasks") {
          return await configuredRunCommand(argv, options);
        }
        nativeCommands.push([...argv]);
        if (argv[1] === "/Query") {
          return commandResult({
            stdout: `<Task><Settings><Enabled>${taskEnabled}</Enabled></Settings></Task>`,
          });
        }
        if (argv.at(-1) === "/DISABLE") {
          taskEnabled = false;
          return !stopFailure
            ? commandResult({ code: 1, stderr: "disable timed out after commit" })
            : commandResult();
        }
        if (fault === "suspension-spawn") {
          throw new Error("spawn schtasks EACCES: enable denied");
        }
        if (fault === "stop-enable-committed") {
          taskEnabled = true;
        }
        return commandResult({ code: 1, stderr: "enable denied" });
      });
      serviceStop.mockRejectedValueOnce(new Error("listener cleanup failed after task stop"));
      mockGitUpdateAfterMutation();
      const originalSignalListeners = process.listenerCount("SIGINT");
      triageCommand.mockImplementationOnce(async () => {
        expect(taskEnabled).toBe(false);
        expect(process.listenerCount("SIGINT")).toBe(originalSignalListeners);
      });
      // This fixture owns a native service; neither a relocated home nor the
      // host's external-repair policy should opt Doctor out of exercising it.
      const reportedError = await withEnvAsync(
        { OPENCLAW_HOME: undefined, OPENCLAW_SERVICE_REPAIR_POLICY: undefined },
        async () => {
          if (command === "doctor") {
            const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
            await maybeOfferUpdateBeforeDoctor({
              options: {},
              root,
              confirm: async () => true,
              outro: vi.fn(),
            });
          } else {
            await updateCommand({});
          }
        },
      ).catch((error: unknown) => error);

      expect(
        nativeCommands.map((argv) => argv.at(-1)),
        `${String(reportedError)}\n${getErrorOutput()}`,
      ).toEqual([
        "/XML",
        "/DISABLE",
        "/ENABLE",
        ...(stopFailure ? ["/XML"] : []),
        ...(fault === "stop-enable-committed" ? ["/DISABLE"] : []),
      ]);
      expect(serviceStop).toHaveBeenCalledTimes(stopFailure ? 1 : 0);
      expect(packageInstallCommandCall() !== undefined).toBe(command === "update");
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
        version: "1.0.0",
      });
      expect(serviceRestart).not.toHaveBeenCalled();
      expect(triageCommand).toHaveBeenCalledOnce();
      expect(reportedError).toEqual(new ExitError(1));
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(triageCommand.mock.calls[0]?.[1]?.recovery).toMatchObject({
        target,
        updateFailure: {
          result: {
            status: "error",
            recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
            verification: {
              runningVersion: "1.0.0",
              versionMatch: true,
              readyz: true,
              settled: true,
            },
            steps: [
              expect.objectContaining({ stderrTail: expect.stringContaining("enable denied") }),
              recoveryVerificationStep(undefined, root),
            ],
          },
        },
      });
    },
  );

  it.each([
    "verification",
    "enable-committed",
    "disable-committed",
    "disable-denied",
    "none",
  ] as const)(
    "settles native Windows task enabled state after update finalization (%s)",
    async (fault) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const root = process.cwd();
      mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway"]);
      mockGitUpdateAfterMutation(
        makeOkUpdateResult({
          mode: "git",
          root,
          after: { version: "1.0.0", buildId: "candidate-build" },
        }),
      );
      mockGatewayHealth("1.0.0", "candidate-gateway", "candidate-build");
      restartHealthTestControl.snapshot = {
        runtime: { status: "running", pid: gatewayFixturePid },
        portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
        healthy: fault === "none",
        staleGatewayPids: [],
        gatewayBootId: "test-gateway-boot",
        gatewayVersion: "1.0.0",
        gatewayBuildId: "candidate-build",
        expectedVersion: "1.0.0",
        probeError: fault === "none" ? undefined : "candidate readiness failed",
      };
      await useNativeScheduledTaskControl();
      const configuredRunCommand = requireValue(
        vi.mocked(runCommandWithTimeout).getMockImplementation(),
        "native update command fixture",
      );
      let taskEnabled = true;
      let disables = 0;
      const nativeActions: string[] = [];
      const activateTask = () => {
        nativeActions.push("/Run");
        if (!taskEnabled) {
          throw new Error("Scheduled Task is disabled");
        }
      };
      serviceRestart.mockImplementation(async () => {
        activateTask();
        return { outcome: "completed" };
      });
      vi.mocked(runDaemonRestart).mockImplementation(async () => {
        activateTask();
        return true;
      });
      vi.mocked(runDaemonInstall).mockImplementation(async () => {
        activateTask();
      });
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[0] !== "schtasks") {
          if (argv[2] === "gateway" && ["install", "start", "restart"].includes(argv[3] ?? "")) {
            activateTask();
          }
          return configuredRunCommand(argv, options);
        }
        const action = argv.at(-1);
        if (argv[1] === "/Query") {
          return commandResult({
            stdout: `<Task><Settings><Enabled>${taskEnabled}</Enabled></Settings></Task>`,
          });
        }
        nativeActions.push(action ?? "");
        if (action === "/DISABLE") {
          disables += 1;
          if (disables > 1 && fault === "disable-denied") {
            return commandResult({ code: 1, stderr: "suspension denied" });
          }
          taskEnabled = false;
          return disables > 1 && fault === "disable-committed"
            ? commandResult({ code: 124, stderr: "disable timed out after commit" })
            : commandResult();
        }
        taskEnabled = true;
        return fault === "enable-committed"
          ? commandResult({ code: 124, stderr: "enable timed out after commit" })
          : commandResult();
      });

      if (fault === "none") {
        await updateCommand({ yes: true, json: true });
        expect(nativeActions).toEqual(["/DISABLE", "/ENABLE", "/Run"]);
      } else {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
        expect(disables).toBe(2);
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason:
            fault === "enable-committed"
              ? "windows-task-autostart-restore-failed"
              : "restart-unhealthy",
        });
        if (fault === "disable-committed" || fault === "disable-denied") {
          expect(lastWriteJsonCall()).toMatchObject({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stderrTail: expect.stringContaining(
                  fault === "disable-committed"
                    ? "disable timed out after commit"
                    : "suspension denied",
                ),
              }),
            ]),
          });
        }
      }
      expect(taskEnabled).toBe(fault === "none" || fault === "disable-denied");
      expect(nativeActions.slice(0, 2)).toEqual(["/DISABLE", "/ENABLE"]);
      if (fault === "enable-committed") {
        expect(nativeActions).not.toContain("/Run");
      }
    },
  );

  it("keeps Windows Scheduled Task autostart disabled after unverified lifecycle failure", async () => {
    await useFileBackedConfig();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const root = await mockPackageInstallAtCaseDir("openclaw-update-recovery-failure");
    primeServiceCommand(
      ["node", path.join(root, "dist", "index.js"), "gateway", "run"],
      { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      resolveGatewayTaskScriptPath(process.env),
    );
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "staged package commands",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      if (argv[2] === "doctor") {
        await fs.unlink(path.join(root, "dist", "index.js"));
        throw new Error("update invariant broke");
      }
      return runFixtureCommand(argv, options);
    });

    try {
      await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledOnce();
      expect(packageInstallCommandCall()).toBeDefined();
      expect(resumeScheduledTaskAutoStartAfterUpdate.mock.calls.length).toBe(0);
      await expect(fs.access(path.join(root, "dist", "index.js"))).resolves.toBeUndefined();
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
        version: "1.0.0",
      });
      expect(serviceRestart).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("does not re-enable Windows task autostart on interruption during package lifecycle", async () => {
    await useFileBackedConfig();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const processOnSpy = vi.spyOn(process, "on");
    const exitCalled = createDeferred();
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      exitCalled.resolve();
      return undefined as never;
    });
    const root = await mockPackageInstallAtCaseDir("openclaw-update-lifecycle-signal");
    primeServiceCommand(
      ["node", path.join(root, "dist", "index.js"), "gateway", "run"],
      { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      resolveGatewayTaskScriptPath(process.env),
    );
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "staged package commands",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      if (argv[2] === "doctor") {
        const listener = processOnSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
        if (typeof listener !== "function") {
          throw new Error("missing signal handler");
        }
        listener();
        throw new Error("interrupted lifecycle");
      }
      return runFixtureCommand(argv, options);
    });
    try {
      await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
      await exitCalled.promise;
      expect(processExitSpy).toHaveBeenCalledWith(130);
      expect(resumeScheduledTaskAutoStartAfterUpdate.mock.calls.length).toBe(0);
      await expect(fs.access(path.join(root, "dist", "index.js"))).resolves.toBeUndefined();
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
        version: "1.0.0",
      });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(serviceRestart).not.toHaveBeenCalled();
      runtimeRecovery.expectInterruptedDoctorPackageRollback(listUpdateRuns({ limit: 1 }));
    } finally {
      platformSpy.mockRestore();
      processOnSpy.mockRestore();
      processExitSpy.mockRestore();
    }
  });
});
