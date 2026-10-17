import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { waitForCliSignalExit } from "./signal-exit-barrier.js";
import * as check from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
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
import { registerWindowsTaskAdmissionTests } from "./update-cli/update-command-windows-preflight.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const {
  defaultRuntime: runtime,
  runCommandWithTimeout: runCommand,
  updateCommand: runUpdate,
  updateGitCheckout: gitUpdate,
} = cli;
const { packageInstallCommandCall: packageInstall, freshRestartCalls: restarts } = check;
const {
  suspendScheduledTaskAutoStartForUpdate: suspendTask,
  resumeScheduledTaskAutoStartAfterUpdate: resumeTask,
} = mocks;

let resetNativeLoader: (() => void) | undefined;
beforeAll(async () => {
  if (process.platform === "win32") {
    return;
  }
  // Match fs-safe's Windows simulation: retain native publication, add host identity facts.
  const nativeUrl = new URL("native.js", import.meta.resolve("@openclaw/fs-safe/root")).href;
  const {
    __loadBundledNativeForTest: loadBundledNative,
    __setNativeLoaderForTest: setNativeLoader,
    __resetNativeLoaderForTest: resetLoader,
  } = await vi.importActual<{
    __loadBundledNativeForTest: () => Record<string, unknown>;
    __setNativeLoaderForTest: (loader: () => Record<string, unknown>) => void;
    __resetNativeLoaderForTest: () => void;
  }>(nativeUrl);
  const binding = loadBundledNative();
  setNativeLoader(() => ({
    ...binding,
    fstatIdentity(fd: number) {
      const stat = fsSync.fstatSync(fd);
      return {
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        nlink: stat.nlink,
        size: stat.size,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
      };
    },
  }));
  resetNativeLoader = resetLoader;
});
afterAll(() => resetNativeLoader?.());

describe("update-cli", () => {
  const nodeExecutable = resolveTestNodeExecPath();
  const fixture = createUpdateCliFixture();
  const gatewayArgs = (root: string, ...args: string[]) => [
    nodeExecutable,
    path.join(root, "dist", "index.js"),
    "gateway",
    ...args,
  ];

  registerWindowsTaskAdmissionTests(fixture);

  registerFailureSelectorTests({
    updateCommand: runUpdate,
    updateFinalizeCommand: cli.updateFinalizeCommand,
    updateGitCheckout: gitUpdate,
    readConfigFileSnapshot: cli.readConfigFileSnapshot,
    profileStateDir: fixture.profileStateDir,
    runUpdateFailureTriage: cli.runUpdateFailureTriage,
    expectSelectorTriageFailure: cli.expectSelectorTriageFailure,
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
      await runUpdate({ yes: true });
    });

    check.expectNoSideEffects(mocks.serviceReadCommand, suspendTask, mocks.serviceStop);
    expect(restarts()).toHaveLength(0);
    expect(cli.runDaemonRestart).not.toHaveBeenCalled();
    expect(packageInstall()).toBeDefined();
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
    mocks.serviceReadCommand.mockResolvedValue({
      programArguments: gatewayArgs(root, "run"),
      environment: {
        OPENCLAW_PROFILE: "work",
        [envKey]: value,
      },
    });
    mocks.serviceLoaded.mockResolvedValue(true);
    mocks.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
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
        await expect(cli.invokeUpdateCli({ yes: true })).rejects.toEqual(new cli.ExitError(1));
      },
    );

    check.expectNoSideEffects(
      mocks.serviceReadRuntime,
      suspendTask,
      mocks.serviceStop,
      mocks.serviceRestart,
    );
    expect(restarts()).toHaveLength(0);
    expect(cli.runDaemonRestart).not.toHaveBeenCalled();
    expect(packageInstall()?.[0]).toBeUndefined();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(check.getLogOutput()).toContain(envKey);
    expect(cli.fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
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
    vi.mocked(cli.resolveGatewayInstallEntrypoint)
      .mockReset()
      .mockImplementation(entrypoints.resolveGatewayInstallEntrypoint);
    fixture.mockRunningManagedGateway(gatewayArgs(root, "run"));
    mocks.serviceStop.mockImplementationOnce(async ({ onMutation }) => {
      onMutation?.({ mode: "bootout" });
      throw new Error("port still busy after bootout");
    });

    await expect(cli.invokeUpdateCli({ channel: "beta", yes: true, json: true })).rejects.toEqual(
      new cli.ExitError(1),
    );

    expect(mocks.serviceStop).toHaveBeenCalledOnce();
    expect(restarts(), check.getErrorOutput()).toHaveLength(1);
    expect(cli.replaceConfigFile).not.toHaveBeenCalled();
    expect(check.lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "managed-service-stop-failed",
      recovery: { serviceRestartSafe: true },
    });
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
      version: "1.0.0",
    });
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
        vi.mocked(cli.resolveUpdateInstallKind).mockResolvedValue("git");
        vi.mocked(cli.resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "git" });
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
      const configuredRunCommand = vi.mocked(runCommand).getMockImplementation();
      if (!configuredRunCommand) {
        throw new Error("Expected installed package command fixture");
      }
      let taskEnabled = true;
      const nativeCommands: string[][] = [];
      vi.mocked(runCommand).mockImplementation(async (argv, options) => {
        if (argv[0] === "git" && argv[argv.indexOf("-C") + 2] === "rev-parse") {
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
      mocks.serviceStop.mockRejectedValueOnce(new Error("listener cleanup failed after task stop"));
      cli.mockGitUpdateAfterMutation();
      const originalSignalListeners = process.listenerCount("SIGINT");
      mocks.triageCommand.mockImplementationOnce(async () => {
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
            await runUpdate({});
          }
        },
      ).catch((error: unknown) => error);

      expect(
        nativeCommands.map((argv) => argv.at(-1)),
        `${String(reportedError)}\n${check.getErrorOutput()}`,
      ).toEqual([
        "/XML",
        "/DISABLE",
        "/ENABLE",
        ...(stopFailure ? ["/XML"] : []),
        ...(fault === "stop-enable-committed" ? ["/DISABLE"] : []),
      ]);
      expect(mocks.serviceStop).toHaveBeenCalledTimes(stopFailure ? 1 : 0);
      if (stopFailure) {
        const nativeOrder = (action: string) => {
          const index = vi
            .mocked(runCommand)
            .mock.calls.findIndex(([argv]) => argv[0] === "schtasks" && argv.at(-1) === action);
          return check.requireValue(
            vi.mocked(runCommand).mock.invocationCallOrder[index],
            `${action} order`,
          );
        };
        const stopOrder = check.requireValue(
          mocks.serviceStop.mock.invocationCallOrder[0],
          "service stop order",
        );
        expect(nativeOrder("/DISABLE")).toBeLessThan(stopOrder);
        expect(stopOrder).toBeLessThan(nativeOrder("/ENABLE"));
      }
      expect(packageInstall() !== undefined).toBe(command === "update");
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
        version: "1.0.0",
      });
      expect(mocks.serviceRestart).not.toHaveBeenCalled();
      expect(mocks.triageCommand).toHaveBeenCalledOnce();
      expect(reportedError).toEqual(new cli.ExitError(1));
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(mocks.triageCommand.mock.calls[0]?.[1]?.recovery).toMatchObject({
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
              expect.objectContaining({ name: "updater-runtime-retention", exitCode: 0 }),
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
      fixture.mockRunningManagedGateway(gatewayArgs(root));
      cli.mockGitUpdateAfterMutation(
        cli.makeOkUpdateResult({
          mode: "git",
          root,
          after: { version: "1.0.0", buildId: "candidate-build" },
        }),
      );
      fixture.mockGatewayHealth("1.0.0", "candidate-gateway", "candidate-build");
      mocks.restartHealthTestControl.snapshot = {
        runtime: { status: "running", pid: mocks.gatewayFixturePid },
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
      const configuredRunCommand = check.requireValue(
        vi.mocked(runCommand).getMockImplementation(),
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
      mocks.serviceRestart.mockImplementation(async () => {
        activateTask();
        return { outcome: "completed" };
      });
      vi.mocked(cli.runDaemonRestart).mockImplementation(async () => {
        activateTask();
        return true;
      });
      vi.mocked(cli.runDaemonInstall).mockImplementation(async () => {
        activateTask();
      });
      vi.mocked(runCommand).mockImplementation(async (argv, options) => {
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
        await runUpdate({ yes: true, json: true });
        expect(nativeActions).toEqual(["/DISABLE", "/ENABLE", "/Run"]);
      } else {
        await expect(runUpdate({ yes: true, json: true })).rejects.toEqual(new cli.ExitError(1));
        expect(disables).toBe(2);
        expect(check.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason:
            fault === "enable-committed"
              ? "windows-task-autostart-restore-failed"
              : "restart-unhealthy",
        });
        if (fault === "disable-committed") {
          expect(check.lastWriteJsonCall()).toMatchObject({
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
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-lifecycle-signal");
    fixture.primeServiceCommand(
      gatewayArgs(root, "run"),
      { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      resolveGatewayTaskScriptPath(process.env),
    );
    mocks.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    suspendTask.mockResolvedValue(true);
    const runFixtureCommand = check.requireValue(
      vi.mocked(runCommand).getMockImplementation(),
      "staged package commands",
    );
    vi.mocked(runCommand).mockImplementation(async (argv, options) => {
      if (argv[2] === "doctor") {
        await fs.unlink(path.join(root, "dist", "index.js"));
        const listeners = process
          .listeners("SIGINT")
          .filter((listener) => !priorSigintListeners.has(listener));
        expect(listeners.length).toBeGreaterThan(0);
        for (const listener of listeners) {
          listener("SIGINT");
        }
        throw new Error("interrupted lifecycle");
      }
      return runFixtureCommand(argv, options);
    });

    const priorSigintListeners = new Set(process.listeners("SIGINT"));
    await expect(runUpdate({ yes: true, restart: false })).rejects.toEqual(new cli.ExitError(1));
    await expect(waitForCliSignalExit()).resolves.toBe(130);
    expect(process.exitCode).toBe(130);
    expect(processExitSpy).not.toHaveBeenCalled();
    expect(resumeTask.mock.calls.length).toBe(0);
    await fs.access(path.join(root, "dist", "index.js"));
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
      version: "1.0.0",
    });
    check.expectNoSideEffects(runtime.exit, mocks.serviceRestart);
    runtimeRecovery.expectInterruptedDoctorPackageRollback(cli.listUpdateRuns({ limit: 1 }));
  });

  it("refuses mutation while a Windows recovery owner is settling", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { maybeStopManagedServiceBeforeMutableUpdate, UpdateCommandAbort } =
      await import("./update-cli/update-command-service.js");
    fixture.mockRunningManagedGateway(gatewayArgs(process.cwd()));
    suspendTask.mockResolvedValue(true);
    resumeTask.mockResolvedValue(true);
    const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
    });
    const recovery = check.requireValue(
      stopped.windowsTaskAutoStartRecovery,
      "task recovery owner",
    );
    try {
      await recovery.restore();
      const completion = recovery.complete();
      expect(() => recovery.beginMutation()).toThrow(UpdateCommandAbort);
      await completion;
      expect(resumeTask).toHaveBeenCalledOnce();
      expect(packageInstall()).toBeUndefined();
    } finally {
      await recovery.complete();
    }
  });

  it("does not restore autostart on a pinned Windows task replaced during service stop", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    fixture.mockRunningManagedGateway(gatewayArgs(process.cwd()));
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
    suspendTask.mockResolvedValue(true);
    const nativeTaskControl = await vi.importActual<typeof import("../daemon/schtasks-control.js")>(
      "../daemon/schtasks-control.js",
    );
    resumeTask.mockImplementation(nativeTaskControl.resumeScheduledTaskAutoStartAfterUpdate);
    mocks.serviceStop.mockImplementationOnce(async () => {
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

    expect(mocks.serviceStop).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.some(([argv]) => argv[0] === "schtasks" && argv.includes("/ENABLE")),
    ).toBe(false);
    expect(packageInstall()?.[0]).toBeUndefined();
  });

  it.each([
    { signal: "SIGINT", phase: "package suspension" },
    { signal: "SIGINT", phase: "service pre-stop inspection" },
    { signal: "SIGBREAK", phase: "Git task suspension" },
  ] as const)(
    "restores Windows Scheduled Task autostart on $signal during $phase",
    async ({ signal, phase }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const processOnSpy = vi.spyOn(process, "on");
      const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const gate = createDeferred();
      const entered = createDeferred();
      const gitMutation = vi.fn();
      let taskSuspended = false;
      const waitForSignal = async () => {
        entered.resolve();
        await gate.promise;
      };
      suspendTask.mockImplementationOnce(async () => {
        if (phase === "package suspension") {
          await waitForSignal();
        }
        taskSuspended = true;
        if (phase === "Git task suspension") {
          await waitForSignal();
        }
        return true;
      });
      if (phase === "Git task suspension") {
        fixture.mockOwnedGitService();
        mocks.serviceLoaded.mockResolvedValue(true);
        vi.mocked(gitUpdate).mockImplementationOnce(async ({ opts: options }) => {
          await check.requireValue(
            options.beforeGitMutation,
            "Git mutation admission",
          )({ schemaVersions: { state: 3, agent: 11 } });
          gitMutation();
          return cli.makeOkUpdateResult({ mode: "git" });
        });
      } else {
        const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-suspension-signal");
        fixture.primeServiceCommand(
          gatewayArgs(root, "run"),
          { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
          resolveGatewayTaskScriptPath(process.env),
        );
      }
      resumeTask.mockImplementation(
        async (_env, options: Parameters<typeof import("../daemon/schtasks.js").resumeTask>[1]) => {
          await options?.beforeMutation?.();
          options?.assertCurrent?.();
          return true;
        },
      );
      if (phase === "service pre-stop inspection") {
        mocks.serviceLoaded.mockResolvedValue(true);
        mocks.serviceReadRuntime.mockImplementation(async () => {
          if (taskSuspended) {
            await waitForSignal();
          }
          return { status: "running", pid: mocks.gatewayFixturePid };
        });
      } else {
        mocks.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      }

      const updatePromise = runUpdate({
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
        check.expectNoSideEffects(processExitSpy, resumeTask, gitMutation);
        gate.resolve();

        await updatePromise;
        expect(resumeTask).toHaveBeenCalledOnce();
        expect(mocks.serviceStop).not.toHaveBeenCalled();
        expect(Boolean(packageInstall())).toBe(phase !== "Git task suspension");
        expect(gitMutation).not.toHaveBeenCalled();
        expect(restarts()).toEqual([]);
        expect(cli.listUpdateRuns({ limit: 1 })).toMatchObject([
          { phase: "finished", status: "skipped", reason: "cancelled" },
        ]);
        expect(runtime.exit).not.toHaveBeenCalledWith(1);
        await expect(waitForCliSignalExit()).resolves.toBe(130);
        expect(process.exitCode).toBe(130);
        expect(processExitSpy).not.toHaveBeenCalled();
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
    mocks.readPackageVersion.mockResolvedValue("2026.4.21");
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
    mocks.serviceReadRuntime.mockResolvedValue({
      status: "running",
      state: "running",
      pid: mocks.gatewayFixturePid,
    });
    suspendTask.mockResolvedValue(true);
    resumeTask.mockResolvedValue(true);

    try {
      await runUpdate({ yes: true, restart: false });
    } catch (cause) {
      throw new Error(`${check.getLogOutput()}\n${check.getErrorOutput()}`, { cause });
    }

    expect(mocks.serviceStop).not.toHaveBeenCalled();
    expect(packageInstall()).toBeDefined();
    expect(resumeTask, `${check.getLogOutput()}\n${check.getErrorOutput()}`).toHaveBeenCalledOnce();
    const suspendOrder = suspendTask.mock.invocationCallOrder[0];
    const installCallIndex = vi
      .mocked(runCommand)
      .mock.calls.findIndex(
        (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
      );
    const installOrder = vi.mocked(runCommand).mock.invocationCallOrder[installCallIndex];
    const resumeOrder = resumeTask.mock.invocationCallOrder[0];
    expect(check.requireValue(installOrder, "package staging order")).toBeLessThan(
      check.requireValue(suspendOrder, "Scheduled Task suspend order"),
    );
    expect(check.requireValue(installOrder, "package install order")).toBeLessThan(
      check.requireValue(resumeOrder, "Scheduled Task resume order"),
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
    mocks.serviceLoaded.mockResolvedValue(true);
    mocks.serviceReadRuntime.mockResolvedValue({
      status: "stopped",
      state: "stopped",
    });
    mocks.windowsOfflineProbe.mockRejectedValue(new Error("synthetic task inspection unavailable"));
    suspendTask.mockResolvedValue(true);

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
      mocks.windowsOfflineProbe.mockReset().mockResolvedValue(null);
    }

    check.expectNoSideEffects(suspendTask, resumeTask, mocks.serviceStop);
  });

  it.each(["doctor failure", "post-core exception"] as const)(
    "keeps Windows Git task autostart disabled after %s",
    async (failureKind) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      fixture.mockRunningManagedGateway(gatewayArgs(process.cwd()));
      suspendTask.mockResolvedValue(true);
      const failure = new Error("post-core configuration could not be read");
      vi.mocked(gitUpdate).mockImplementationOnce(async ({ opts }) => {
        await check.requireValue(opts.beforeGitMutation, "Git mutation admission")({});
        if (failureKind === "post-core exception") {
          vi.mocked(cli.readConfigFileSnapshot).mockRejectedValue(failure);
          return cli.makeOkUpdateResult({ mode: "git", root: process.cwd() });
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

      await expect(runUpdate({ yes: true, json: true })).rejects.toEqual(new cli.ExitError(1));
      check.expectNoSideEffects(runtime.exit, mocks.triageAfterFailure);
      expect(suspendTask).toHaveBeenCalledOnce();
      expect(mocks.serviceStop).toHaveBeenCalledOnce();
      expect(suspendTask.mock.invocationCallOrder[0]).toBeLessThan(
        check.requireValue(mocks.serviceStop.mock.invocationCallOrder[0], "Git service stop order"),
      );
      expect(resumeTask).not.toHaveBeenCalled();
      expect(restarts()).toHaveLength(0);
      check.expectNoSideEffects(mocks.serviceStart, mocks.serviceRestart);
    },
  );
});
