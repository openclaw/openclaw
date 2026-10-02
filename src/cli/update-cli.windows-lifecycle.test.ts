import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import {
  expectNoSideEffects,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  databasePreflightMocks,
  gatewayFixturePid,
  readPackageVersion,
  restartHealthTestControl,
  resumeScheduledTaskAutoStartAfterUpdate,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  suspendScheduledTaskAutoStartForUpdate,
  triageAfterFailure,
  triageCommand,
  windowsOfflineProbe,
} from "./update-cli-mocks.test-support.js";
import {
  ExitError,
  defaultRuntime,
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
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  recoveryVerificationStep,
  registerFailureSelectorTests,
} from "./update-cli/update-cli-failure-recovery.test-support.js";
import {
  writeJsonFixture,
  writeNpmPackageInstall,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const nodeExecutable = resolveTestNodeExecPath();
  const fixture = createUpdateCliFixture();

  registerFailureSelectorTests({
    updateCommand,
    updateFinalizeCommand,
    updateGitCheckout,
    readConfigFileSnapshot,
    profileStateDir: fixture.profileStateDir,
    runUpdateFailureTriage,
    expectSelectorTriageFailure,
  });

  it("does not inspect or mutate a Windows host service from an isolated install", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDir = fixture.tempDirs.make("openclaw-update-isolated-service-");
    const { nodeModules } = await fixture.setupInstalledPackageRoot(tempDir);
    fixture.mockRunningManagedGateway();
    fixture.mockFileBackedPathExists();
    fixture.mockNpmGlobalRoot(nodeModules);

    await withEnvAsync({ OPENCLAW_HOME: path.join(tempDir, "relocated-home") }, async () => {
      fixture.initializeExistingUpdateProfile();
      await updateCommand({ yes: true });
    });

    expect(serviceReadCommand).not.toHaveBeenCalled();
    expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(freshRestartCalls()).toHaveLength(0);
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeDefined();
  });

  it("rejects a conflicting Windows task selector before mutation", async () => {
    const platform = "win32";
    const envKey = "OPENCLAW_WINDOWS_TASK_NAME";
    const value = "OpenClaw Gateway";
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const tempDir = fixture.tempDirs.make(`openclaw-update-${platform}-selector-`);
    const home = path.join(tempDir, "home");
    const stateDir = path.join(home, ".openclaw-work");
    const { nodeModules, pkgRoot: root } = await fixture.setupInstalledPackageRoot(tempDir);
    serviceReadCommand.mockResolvedValue({
      programArguments: [nodeExecutable, path.join(root, "dist", "index.js"), "gateway", "run"],
      environment: {
        OPENCLAW_PROFILE: "work",
        [envKey]: value,
      },
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    fixture.mockFileBackedPathExists();
    fixture.mockNpmGlobalRoot(nodeModules);

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

    expectNoSideEffects(
      serviceReadRuntime,
      suspendScheduledTaskAutoStartForUpdate,
      serviceStop,
      serviceRestart,
    );
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
  });

  it("recovers a service stop that failed after mutation", async () => {
    const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-partial-stop");
    fixture.mockFileBackedPathExists();
    const entrypoints = await vi.importActual<typeof import("../daemon/gateway-entrypoint.js")>(
      "../daemon/gateway-entrypoint.js",
    );
    // A failed stop never reaches package Doctor or the fresh-process decision.
    vi.mocked(resolveGatewayInstallEntrypoint)
      .mockReset()
      .mockImplementation(entrypoints.resolveGatewayInstallEntrypoint);
    fixture.mockRunningManagedGateway([
      nodeExecutable,
      path.join(root, "dist", "index.js"),
      "gateway",
      "run",
    ]);
    serviceStop.mockImplementationOnce(async ({ onMutation }) => {
      onMutation?.({ mode: "bootout" });
      throw new Error("port still busy after bootout");
    });

    await expect(invokeUpdateCli({ channel: "beta", yes: true, json: true })).rejects.toEqual(
      new ExitError(1),
    );

    expect(serviceStop).toHaveBeenCalledOnce();
    expect(freshRestartCalls(), getErrorOutput()).toHaveLength(1);
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "managed-service-stop-failed",
      recovery: { serviceRestartSafe: true },
    });
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
      version: "1.0.0",
    });
  });

  it("restores Windows Scheduled Task autostart when service stop fails", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-stop-failure");
    fixture.mockRunningManagedGateway([
      nodeExecutable,
      path.join(root, "dist", "index.js"),
      "gateway",
      "run",
    ]);
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    serviceStop.mockRejectedValueOnce(new Error("stop failed"));
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);

    await expect(invokeUpdateCli({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledTimes(1);
    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(freshRestartCalls()).toHaveLength(0);
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
    { command: "update", fault: "stop-enable-committed" },
    { command: "doctor", fault: "suspension-spawn" },
  ] as const)(
    "starts $command triage when native $fault preparation cannot restore task autostart",
    async ({ command, fault }) => {
      const stopFailure = fault === "stop-enable-committed";
      runtimeRecovery.stubNodeRuntime();
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      fixture.setTty(true);
      fixture.setStdoutTty(true);
      const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-native-preparation");
      if (command === "doctor") {
        vi.mocked(resolveUpdateInstallKind).mockResolvedValue("git");
        vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "git" });
      }
      fixture.mockRunningManagedGateway([
        process.execPath,
        path.join(root, "dist", "entry.js"),
        "gateway",
        "run",
      ]);
      fixture.mockFileBackedPathExists();
      const target = {
        stateDir: fixture.profileStateDir("native-preparation"),
        configPath: path.join(fixture.profileStateDir("native-preparation"), "openclaw.json"),
        defaultWorkspaceDir: path.join(fixture.profileStateDir("native-preparation"), "workspace"),
      };
      fixture.initializeExistingUpdateProfile({
        ...process.env,
        OPENCLAW_STATE_DIR: target.stateDir,
      });
      fixture.tempDirsToCleanup.add(target.stateDir);
      await fs.mkdir(target.stateDir, { recursive: true });
      await writeJsonFixture(target.configPath, fixture.baseSnapshot.config);
      fixture.primeServiceCommand(
        [process.execPath, path.join(root, "dist", "entry.js"), "gateway", "run"],
        {
          OPENCLAW_PROFILE: "native-preparation",
          OPENCLAW_STATE_DIR: target.stateDir,
          OPENCLAW_CONFIG_PATH: target.configPath,
          OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
        },
        path.join(target.stateDir, "gateway.cmd"),
      );
      await fixture.useNativeScheduledTaskControl();
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

  it.each(["enable-committed", "disable-committed", "none"] as const)(
    "settles native Windows task enabled state after update finalization (%s)",
    async (fault) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const root = process.cwd();
      fixture.mockRunningManagedGateway([
        nodeExecutable,
        path.join(root, "dist", "index.js"),
        "gateway",
      ]);
      mockGitUpdateAfterMutation(
        makeOkUpdateResult({
          mode: "git",
          root,
          after: { version: "1.0.0", buildId: "candidate-build" },
        }),
      );
      fixture.mockGatewayHealth("1.0.0", "candidate-gateway", "candidate-build");
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
      await fixture.useNativeScheduledTaskControl();
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
        if (fault === "disable-committed") {
          expect(lastWriteJsonCall()).toMatchObject({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stderrTail: expect.stringContaining("disable timed out after commit"),
              }),
            ]),
          });
        }
      }
      expect(taskEnabled).toBe(fault === "none");
      expect(nativeActions.slice(0, 2)).toEqual(["/DISABLE", "/ENABLE"]);
      if (fault === "enable-committed") {
        expect(nativeActions).not.toContain("/Run");
      }
    },
  );

  it("restores package files without re-enabling Windows autostart after interruption", async () => {
    await fixture.useFileBackedConfig();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const processOnSpy = vi.spyOn(process, "on");
    const exitCalled = createDeferred();
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      exitCalled.resolve();
      return undefined as never;
    });
    const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-lifecycle-signal");
    fixture.primeServiceCommand(
      [nodeExecutable, path.join(root, "dist", "index.js"), "gateway", "run"],
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
        const listener = processOnSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
        if (typeof listener !== "function") {
          throw new Error("missing signal handler");
        }
        listener();
        throw new Error("interrupted lifecycle");
      }
      return runFixtureCommand(argv, options);
    });

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
  });

  it("refuses mutation while a Windows recovery owner is settling", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { maybeStopManagedServiceBeforeMutableUpdate, UpdateCommandAbort } =
      await import("./update-cli/update-command-service.js");
    fixture.mockRunningManagedGateway([
      nodeExecutable,
      path.join(process.cwd(), "dist", "index.js"),
      "gateway",
    ]);
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
    const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
    });
    const recovery = requireValue(stopped.windowsTaskAutoStartRecovery, "task recovery owner");
    try {
      await recovery.restore();
      const completion = recovery.complete();
      expect(() => recovery.beginMutation()).toThrow(UpdateCommandAbort);
      await completion;
      expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
      expect(packageInstallCommandCall()).toBeUndefined();
    } finally {
      await recovery.complete();
    }
  });

  it("does not restore autostart on a pinned Windows task replaced during service stop", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    fixture.mockRunningManagedGateway([
      nodeExecutable,
      path.join(process.cwd(), "dist", "index.js"),
      "gateway",
    ]);
    const { maybeStopManagedServiceBeforeMutableUpdate } =
      await import("./update-cli/update-command-service.js");
    const params = {
      root: process.cwd(),
      updateInstallKind: "package" as const,
      shouldRestart: true,
      jsonMode: true,
    };
    const expectedService = await maybeStopManagedServiceBeforeMutableUpdate({
      ...params,
      phase: "inspect",
    });
    if (expectedService.serviceUpdateVerdict?.kind !== "owned") {
      throw new Error("expected owned fixture launcher");
    }
    expectedService.serviceUpdateVerdict.refreshDefinition = false;
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    const nativeTaskControl = await vi.importActual<typeof import("../daemon/schtasks-control.js")>(
      "../daemon/schtasks-control.js",
    );
    resumeScheduledTaskAutoStartAfterUpdate.mockImplementation(
      nativeTaskControl.resumeScheduledTaskAutoStartAfterUpdate,
    );
    serviceStop.mockImplementationOnce(async () => {
      fixture.primeServiceCommand(
        [nodeExecutable, "/another-install/openclaw.mjs", "gateway", "run"],
        undefined,
        resolveGatewayTaskScriptPath(process.env),
      );
      throw new Error("stop failed after task replacement");
    });

    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({ ...params, expectedService }),
    ).rejects.toThrow("restore Windows Scheduled Task autostart");

    expect(serviceStop).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(runCommandWithTimeout)
        .mock.calls.some(([argv]) => argv[0] === "schtasks" && argv.includes("/ENABLE")),
    ).toBe(false);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  it.each([
    { signal: "SIGINT", phase: "package suspension" },
    { signal: "SIGINT", phase: "service pre-stop inspection" },
    { signal: "SIGBREAK", phase: "Git schema preflight" },
  ] as const)(
    "restores Windows Scheduled Task autostart on $signal during $phase",
    async ({ signal, phase }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const processOnSpy = vi.spyOn(process, "on");
      const exitCalled = createDeferred();
      const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        exitCalled.resolve();
        return undefined as never;
      });
      const gate = createDeferred();
      const entered = createDeferred();
      const gitMutation = vi.fn();
      let taskSuspended = false;
      const waitForSignal = async () => {
        entered.resolve();
        await gate.promise;
      };
      suspendScheduledTaskAutoStartForUpdate.mockImplementationOnce(async () => {
        if (phase === "package suspension") {
          await waitForSignal();
        }
        taskSuspended = true;
        return true;
      });
      if (phase === "Git schema preflight") {
        fixture.mockOwnedGitService();
        serviceLoaded.mockResolvedValue(true);
        vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
          await requireValue(
            options.beforeGitMutation,
            "Git mutation admission",
          )({ schemaVersions: { state: 3, agent: 11 } });
          gitMutation();
          return makeOkUpdateResult({ mode: "git" });
        });
        databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(async () => {
          if (taskSuspended) {
            await waitForSignal();
          }
          return { incompatible: [], indeterminate: [] };
        });
      } else {
        const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-suspension-signal");
        fixture.primeServiceCommand(
          [nodeExecutable, path.join(root, "dist", "index.js"), "gateway", "run"],
          { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
          resolveGatewayTaskScriptPath(process.env),
        );
      }
      resumeScheduledTaskAutoStartAfterUpdate.mockImplementation(
        async (
          _env,
          options: Parameters<
            typeof import("../daemon/schtasks.js").resumeScheduledTaskAutoStartAfterUpdate
          >[1],
        ) => {
          await options?.beforeMutation?.();
          options?.assertCurrent?.();
          return true;
        },
      );
      if (phase === "service pre-stop inspection") {
        serviceLoaded.mockResolvedValue(true);
        serviceReadRuntime.mockImplementation(async () => {
          if (taskSuspended) {
            await waitForSignal();
          }
          return { status: "running", pid: gatewayFixturePid };
        });
      } else {
        serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      }

      const updatePromise = updateCommand({
        yes: true,
        restart: phase === "service pre-stop inspection",
      });
      try {
        await Promise.race([
          entered.promise,
          updatePromise.then(() => {
            throw new Error(`update completed before ${phase}`);
          }),
        ]);
        const signalListeners = processOnSpy.mock.calls
          .filter(([event]) => event === signal)
          .map(([, listener]) => listener);
        expect(signalListeners.length).toBeGreaterThan(0);
        // A native signal reaches every invocation-owned listener in registration order.
        for (const listener of signalListeners) {
          listener();
        }
        for (const listener of signalListeners) {
          listener();
        }
        expect(processExitSpy).not.toHaveBeenCalled();
        expect(resumeScheduledTaskAutoStartAfterUpdate).not.toHaveBeenCalled();
        expect(gitMutation).not.toHaveBeenCalled();
        gate.resolve();

        await updatePromise;
        expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
        expect(serviceStop).not.toHaveBeenCalled();
        expect(Boolean(packageInstallCommandCall())).toBe(phase !== "Git schema preflight");
        expect(gitMutation).not.toHaveBeenCalled();
        expect(freshRestartCalls()).toEqual([]);
        expect(listUpdateRuns({ limit: 1 })).toMatchObject([
          { phase: "finished", status: "skipped", reason: "cancelled" },
        ]);
        expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
        await exitCalled.promise;
        expect(processExitSpy).toHaveBeenCalledWith(130);
        expect(processExitSpy.mock.calls.every(([code]) => code === 130)).toBe(true);
      } finally {
        gate.resolve();
        await updatePromise;
      }
    },
  );

  it("guards a running Windows task during a no-restart package update", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "homedir").mockReturnValue(fixture.fixtureRoot);
    const { nodeModules, pkgRoot, entryPath } = await fixture.setupInstalledPackageRoot(
      fixture.createCaseDir("openclaw-update-stopped-task"),
    );
    fixture.primeNpmChannelTag("latest", "2026.4.22");
    fixture.mockFileBackedPathExists();
    readPackageVersion.mockResolvedValue("2026.4.21");
    fixture.mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
        await writeNpmPackageInstall(argv, pkgRoot, "2026.4.22");
      }
    });
    fixture.primeServiceCommand(
      [nodeExecutable, entryPath, "gateway", "run"],
      { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      resolveGatewayTaskScriptPath(process.env),
    );
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      state: "running",
      pid: gatewayFixturePid,
    });
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);

    try {
      await updateCommand({ yes: true, restart: false });
    } catch (cause) {
      throw new Error(`${getLogOutput()}\n${getErrorOutput()}`, { cause });
    }

    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeDefined();
    expect(
      resumeScheduledTaskAutoStartAfterUpdate,
      `${getLogOutput()}\n${getErrorOutput()}`,
    ).toHaveBeenCalledOnce();
    const suspendOrder = suspendScheduledTaskAutoStartForUpdate.mock.invocationCallOrder[0];
    const installCallIndex = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.findIndex(
        (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
      );
    const installOrder =
      vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[installCallIndex];
    const resumeOrder = resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0];
    expect(requireValue(installOrder, "package staging order")).toBeLessThan(
      requireValue(suspendOrder, "Scheduled Task suspend order"),
    );
    expect(requireValue(installOrder, "package install order")).toBeLessThan(
      requireValue(resumeOrder, "Scheduled Task resume order"),
    );
  });

  it("leaves a foreign Windows task untouched when offline inspection fails", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const updateRoot = fixture.tempDirs.make("openclaw-update-foreign-task-");
    const foreignRoot = fixture.tempDirs.make("openclaw-update-foreign-task-owner-");
    const foreignEntrypoint = await writeOpenClawPackageFixture(foreignRoot, "2026.4.21", {
      entrySource: "export {};\n",
    });
    await Promise.all(
      [".git", "src", "extensions"].map((directory) => fs.mkdir(path.join(foreignRoot, directory))),
    );
    fixture.primeServiceCommand(
      [nodeExecutable, foreignEntrypoint, "gateway", "run"],
      undefined,
      resolveGatewayTaskScriptPath(process.env),
    );
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "stopped",
      state: "stopped",
    });
    windowsOfflineProbe.mockRejectedValue(new Error("synthetic task inspection unavailable"));
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);

    try {
      const { maybeStopManagedServiceBeforeMutableUpdate } =
        await import("./update-cli/update-command-service.js");
      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({
          root: updateRoot,
          updateInstallKind: "package",
          shouldRestart: false,
          jsonMode: false,
        }),
      ).resolves.toMatchObject({
        inspected: true,
        running: false,
        offline: false,
        serviceUpdateVerdict: { kind: "foreign" },
      });
    } finally {
      windowsOfflineProbe.mockReset().mockResolvedValue(null);
    }

    expectNoSideEffects(
      suspendScheduledTaskAutoStartForUpdate,
      resumeScheduledTaskAutoStartAfterUpdate,
      serviceStop,
    );
  });

  it.each(["doctor failure", "post-core exception"] as const)(
    "keeps Windows Git task autostart disabled after %s",
    async (failureKind) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      fixture.mockRunningManagedGateway([
        nodeExecutable,
        path.join(process.cwd(), "dist", "index.js"),
        "gateway",
      ]);
      suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
      const failure = new Error("post-core configuration could not be read");
      vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts }) => {
        await requireValue(opts.beforeGitMutation, "Git mutation admission")({});
        if (failureKind === "post-core exception") {
          vi.mocked(readConfigFileSnapshot).mockRejectedValue(failure);
          return makeOkUpdateResult({ mode: "git", root: process.cwd() });
        }
        return {
          status: "error",
          mode: "git",
          root: process.cwd(),
          reason: "doctor-failed",
          recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
          steps: [],
          durationMs: 100,
        };
      });

      await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      if (failureKind === "post-core exception") {
        expect(triageAfterFailure.mock.calls.map(([, context]) => context)).toContainEqual(
          expect.objectContaining({ kind: "update", error: failure.message }),
        );
      }
      expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledOnce();
      expect(serviceStop).toHaveBeenCalledOnce();
      expect(suspendScheduledTaskAutoStartForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        requireValue(serviceStop.mock.invocationCallOrder[0], "Git service stop order"),
      );
      expect(resumeScheduledTaskAutoStartAfterUpdate).not.toHaveBeenCalled();
      expect(freshRestartCalls()).toHaveLength(0);
      expectNoSideEffects(serviceStart, serviceRestart);
    },
  );
});
