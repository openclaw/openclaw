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
import * as service from "./update-cli-mocks.test-support.js";
import {
  suspendScheduledTaskAutoStartForUpdate as suspendTask,
  resumeScheduledTaskAutoStartAfterUpdate as resumeTask,
} from "./update-cli-mocks.test-support.js";
import * as api from "./update-cli-modules.test-support.js";
import { registerFailureSelectorTests } from "./update-cli/update-cli-failure-recovery.test-support.js";
import {
  writeJsonFixture,
  writeNpmPackageInstall,
} from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";
import { registerWindowsTaskAdmissionTests } from "./update-cli/update-command-windows-preflight.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

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

// Queries still use schtasks; enabled-state mutations use the native COM adapter.
function scheduledTaskAction(argv: readonly string[]): string | undefined {
  if (argv[0] === "schtasks") {
    return argv.at(-1);
  }
  const encodedIndex = argv.indexOf("-EncodedCommand");
  if (path.win32.basename(argv[0] ?? "").toLowerCase() !== "powershell.exe" || encodedIndex < 0) {
    return undefined;
  }
  const script = Buffer.from(argv[encodedIndex + 1] ?? "", "base64").toString("utf16le");
  const enabled = /^\$task\.Enabled=\$(true|false)$/mu.exec(script)?.[1];
  return enabled === undefined ? undefined : enabled === "true" ? "/ENABLE" : "/DISABLE";
}

describe("update-cli", () => {
  const nodeExecutable = resolveTestNodeExecPath();
  const fixture = createUpdateCliFixture();
  const gatewayArgs = (root = process.cwd(), run = false) => [
    nodeExecutable,
    path.join(root, "dist", "index.js"),
    "gateway",
    ...(run ? ["run"] : []),
  ];
  const primeTask = (entrypoint: string) =>
    fixture.primeServiceCommand(
      [nodeExecutable, entrypoint, "gateway", "run"],
      { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      resolveGatewayTaskScriptPath(process.env),
    );
  const stoppedRuntime = () =>
    service.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
  const expectPackageVersion = async (root: string) =>
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
      version: "1.0.0",
    });
  const commandOrder = (matches: (argv: readonly string[]) => boolean) => {
    const command = vi.mocked(api.runCommandWithTimeout);
    return requireValue(
      command.mock.invocationCallOrder[command.mock.calls.findIndex(([argv]) => matches(argv))],
      "command order",
    );
  };
  const serviceParams = () => ({
    root: process.cwd(),
    updateInstallKind: "package" as const,
    shouldRestart: true,
    jsonMode: true,
  });

  registerWindowsTaskAdmissionTests(fixture);

  registerFailureSelectorTests({
    updateCommand: api.updateCommand,
    updateFinalizeCommand: api.updateFinalizeCommand,
    updateGitCheckout: api.updateGitCheckout,
    readConfigFileSnapshot: api.readConfigFileSnapshot,
    profileStateDir: fixture.profileStateDir,
    runUpdateFailureTriage: api.runUpdateFailureTriage,
    expectSelectorTriageFailure: api.expectSelectorTriageFailure,
  });

  it("rejects a conflicting Windows task selector before mutation", async () => {
    const envKey = "OPENCLAW_WINDOWS_TASK_NAME";
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDir = fixture.tempDirs.make("openclaw-update-win32-selector-");
    const home = path.join(tempDir, "home");
    const stateDir = path.join(home, ".openclaw-work");
    const { nodeModules, pkgRoot: root } = await fixture.setupInstalledPackageRoot(tempDir);
    service.serviceReadCommand.mockResolvedValue({
      programArguments: gatewayArgs(root, true),
      environment: { OPENCLAW_PROFILE: "work", [envKey]: "OpenClaw Gateway" },
    });
    service.serviceLoaded.mockResolvedValue(true);
    stoppedRuntime();
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
        await expect(api.invokeUpdateCli({ yes: true })).rejects.toEqual(new api.ExitError(1));
      },
    );

    expectNoSideEffects(
      service.serviceReadRuntime,
      suspendTask,
      service.serviceStop,
      service.serviceRestart,
    );
    expect(freshRestartCalls()).toHaveLength(0);
    expect(api.runDaemonRestart).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(api.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getLogOutput()).toContain(envKey);
    expect(api.fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
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
    vi.mocked(api.resolveGatewayInstallEntrypoint)
      .mockReset()
      .mockImplementation(entrypoints.resolveGatewayInstallEntrypoint);
    fixture.mockRunningManagedGateway(gatewayArgs(root, true));
    service.serviceStop.mockImplementationOnce(async ({ onMutation }) => {
      onMutation?.({ mode: "bootout" });
      throw new Error("port still busy after bootout");
    });

    await expect(api.invokeUpdateCli({ channel: "beta", yes: true, json: true })).rejects.toEqual(
      new api.ExitError(1),
    );

    expect(freshRestartCalls(), getErrorOutput()).toHaveLength(1);
    expect(api.replaceConfigFile).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "managed-service-stop-failed",
      recovery: { serviceRestartSafe: true },
    });
    await expectPackageVersion(root);
  });

  it("starts Doctor triage when native preparation cannot restore task autostart", async () => {
    runtimeRecovery.stubNodeRuntime();
    fixture.setTty(true);
    fixture.setStdoutTty(true);
    const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-native-preparation");
    vi.mocked(api.resolveUpdateInstallKind).mockResolvedValue("git");
    vi.mocked(api.resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "git" });
    fixture.mockRunningManagedGateway([
      process.execPath,
      path.join(root, "dist", "entry.js"),
      "gateway",
      "run",
    ]);
    fixture.mockFileBackedPathExists();
    const stateDir = fixture.profileStateDir("native-preparation");
    const target = {
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      defaultWorkspaceDir: path.join(stateDir, "workspace"),
    };
    fixture.initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    fixture.tempDirsToCleanup.add(stateDir);
    await fs.mkdir(stateDir, { recursive: true });
    await writeJsonFixture(target.configPath, fixture.baseSnapshot.config);
    const serviceEnv = {
      OPENCLAW_PROFILE: "native-preparation",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: target.configPath,
      OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
    };
    fixture.primeServiceCommand(
      [process.execPath, path.join(root, "dist", "entry.js"), "gateway", "run"],
      serviceEnv,
      path.join(stateDir, "gateway.cmd"),
    );
    await fixture.useNativeScheduledTaskControl();
    const configuredRunCommand = requireValue(
      vi.mocked(api.runCommandWithTimeout).getMockImplementation(),
      "installed package command fixture",
    );
    let taskEnabled = true;
    const nativeCommands: string[][] = [];
    vi.mocked(api.runCommandWithTimeout).mockImplementation(async (argv, options) => {
      if (argv[0] === "git" && argv[argv.indexOf("-C") + 2] === "rev-parse") {
        return commandResult({ stdout: `${root}\n` });
      }
      const action = scheduledTaskAction(argv);
      if (action === undefined) {
        return configuredRunCommand(argv, options);
      }
      nativeCommands.push([...argv]);
      if (action === "/XML") {
        return commandResult({
          stdout: `<Task><Settings><Enabled>${taskEnabled}</Enabled></Settings></Task>`,
        });
      }
      if (action === "/DISABLE") {
        taskEnabled = false;
        return commandResult({ code: 1, stderr: "disable timed out after commit" });
      }
      throw new Error("spawn PowerShell EACCES: enable denied");
    });
    api.mockGitUpdateAfterMutation();
    const originalSignalListeners = process.listenerCount("SIGINT");
    service.triageCommand.mockImplementationOnce(async () => {
      expect(taskEnabled).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(originalSignalListeners);
    });
    const reportedError = await withEnvAsync(
      { OPENCLAW_HOME: undefined, OPENCLAW_SERVICE_REPAIR_POLICY: undefined },
      async () => {
        const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
        await maybeOfferUpdateBeforeDoctor({
          options: {},
          root,
          confirm: async () => true,
          outro: vi.fn(),
        });
      },
    ).catch((error: unknown) => error);
    expect(
      nativeCommands.map(scheduledTaskAction),
      `${String(reportedError)}\n${getErrorOutput()}`,
    ).toEqual(["/XML", "/DISABLE", "/ENABLE"]);
    expectNoSideEffects(service.serviceStop, service.serviceRestart, api.defaultRuntime.exit);
    expect(packageInstallCommandCall()).toBeUndefined();
    await expectPackageVersion(root);
    expect(freshRestartCalls()).toEqual([]);
    expect(reportedError).toEqual(new api.ExitError(1));
    const recovery = service.triageCommand.mock.calls[0]?.[1]?.recovery;
    expect(recovery).toHaveProperty("updateFailure.result.verification", {});
    expect(recovery).toMatchObject({
      target,
      updateFailure: {
        result: {
          status: "error",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        },
      },
    });
    expect(recovery).toHaveProperty(
      "updateFailure.result.steps.1.stderrTail",
      expect.stringContaining("enable denied"),
    );
  });

  it("restores package files without re-enabling Windows autostart after interruption", async () => {
    await fixture.useFileBackedConfig();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-lifecycle-signal");
    primeTask(path.join(root, "dist", "index.js"));
    stoppedRuntime();
    suspendTask.mockResolvedValue(true);
    const runFixtureCommand = requireValue(
      vi.mocked(api.runCommandWithTimeout).getMockImplementation(),
      "staged package commands",
    );
    vi.mocked(api.runCommandWithTimeout).mockImplementation(async (argv, options) => {
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
    await expect(api.updateCommand({ yes: true, restart: false })).rejects.toEqual(
      new api.ExitError(1),
    );
    await expect(waitForCliSignalExit()).resolves.toBe(130);
    expect(process.exitCode).toBe(130);
    expectNoSideEffects(
      processExitSpy,
      resumeTask,
      api.defaultRuntime.exit,
      service.serviceRestart,
    );
    await fs.access(path.join(root, "dist", "index.js"));
    await expectPackageVersion(root);
    runtimeRecovery.expectInterruptedDoctorPackageRollback(api.listUpdateRuns({ limit: 1 }));
  });

  it("refuses mutation while a Windows recovery owner is settling", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { maybeStopManagedServiceBeforeMutableUpdate, UpdateCommandAbort } =
      await import("./update-cli/update-command-service.js");
    fixture.mockRunningManagedGateway(gatewayArgs());
    suspendTask.mockResolvedValue(true);
    resumeTask.mockResolvedValue(true);
    const stopped = await maybeStopManagedServiceBeforeMutableUpdate(serviceParams());
    const recovery = requireValue(stopped.windowsTaskAutoStartRecovery, "task recovery owner");
    try {
      await recovery.restore();
      const completion = recovery.complete();
      expect(() => recovery.beginMutation()).toThrow(UpdateCommandAbort);
      await completion;
      expect(resumeTask).toHaveBeenCalledOnce();
    } finally {
      await recovery.complete();
    }
  });

  it("does not restore autostart on a pinned Windows task replaced during service stop", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    fixture.mockRunningManagedGateway(gatewayArgs());
    const { maybeStopManagedServiceBeforeMutableUpdate } =
      await import("./update-cli/update-command-service.js");
    const params = serviceParams();
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
    service.serviceStop.mockImplementationOnce(async () => {
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

    expect(
      vi
        .mocked(api.runCommandWithTimeout)
        .mock.calls.some(([argv]) => scheduledTaskAction(argv) === "/ENABLE"),
    ).toBe(false);
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
        service.serviceLoaded.mockResolvedValue(true);
        vi.mocked(api.updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
          await requireValue(
            options.beforeGitMutation,
            "Git mutation admission",
          )({ schemaVersions: { state: 3, agent: 11 } });
          gitMutation();
          return api.makeOkUpdateResult({ mode: "git" });
        });
      } else {
        const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-suspension-signal");
        primeTask(path.join(root, "dist", "index.js"));
      }
      resumeTask.mockImplementation(
        async (
          _env,
          options: Parameters<
            typeof import("../daemon/schtasks-control.js").resumeScheduledTaskAutoStartAfterUpdate
          >[1],
        ) => {
          await options?.beforeMutation?.();
          options?.assertCurrent?.();
          return true;
        },
      );
      if (phase === "service pre-stop inspection") {
        service.serviceLoaded.mockResolvedValue(true);
        service.serviceReadRuntime.mockImplementation(async () => {
          if (taskSuspended) {
            await waitForSignal();
          }
          return { status: "running", pid: service.gatewayFixturePid };
        });
      } else {
        stoppedRuntime();
      }

      const updatePromise = api.updateCommand({
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
        expectNoSideEffects(processExitSpy, resumeTask, gitMutation);
        gate.resolve();

        await updatePromise;
        expect(resumeTask).toHaveBeenCalledOnce();
        expect(service.serviceStop).not.toHaveBeenCalled();
        expect(Boolean(packageInstallCommandCall())).toBe(phase !== "Git task suspension");
        expect(gitMutation).not.toHaveBeenCalled();
        expect(freshRestartCalls()).toEqual([]);
        expect(api.listUpdateRuns({ limit: 1 })).toMatchObject([
          { phase: "finished", status: "skipped", reason: "cancelled" },
        ]);
        expect(api.defaultRuntime.exit).not.toHaveBeenCalledWith(1);
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
    service.readPackageVersion.mockResolvedValue("2026.4.21");
    fixture.mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
        await writeNpmPackageInstall(argv, pkgRoot, "2026.4.22");
      }
    });
    primeTask(entryPath);
    service.serviceReadRuntime.mockResolvedValue({
      status: "running",
      state: "running",
      pid: service.gatewayFixturePid,
    });
    suspendTask.mockResolvedValue(true);
    resumeTask.mockResolvedValue(true);

    await api.updateCommand({ yes: true, restart: false });

    expect(service.serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeDefined();
    expect(resumeTask, `${getLogOutput()}\n${getErrorOutput()}`).toHaveBeenCalledOnce();
    const suspendOrder = suspendTask.mock.invocationCallOrder[0];
    const installOrder = commandOrder((argv) => argv[0] === "npm" && argv[1] === "i");
    const resumeOrder = resumeTask.mock.invocationCallOrder[0];
    expect(installOrder).toBeLessThan(requireValue(suspendOrder, "Scheduled Task suspend order"));
    expect(installOrder).toBeLessThan(requireValue(resumeOrder, "Scheduled Task resume order"));
  });

  it.each(["doctor failure", "post-core exception"] as const)(
    "keeps Windows Git task autostart disabled after %s",
    async (failureKind) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      fixture.mockRunningManagedGateway(gatewayArgs());
      suspendTask.mockResolvedValue(true);
      const failure = new Error("post-core configuration could not be read");
      vi.mocked(api.updateGitCheckout).mockImplementationOnce(async ({ opts }) => {
        await requireValue(opts.beforeGitMutation, "Git mutation admission")({});
        if (failureKind === "post-core exception") {
          vi.mocked(api.readConfigFileSnapshot).mockRejectedValue(failure);
          return api.makeOkUpdateResult({ mode: "git", root: process.cwd() });
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

      await expect(api.updateCommand({ yes: true, json: true })).rejects.toEqual(
        new api.ExitError(1),
      );
      expectNoSideEffects(
        api.defaultRuntime.exit,
        service.triageAfterFailure,
        resumeTask,
        service.serviceStart,
        service.serviceRestart,
      );
      expect(suspendTask.mock.invocationCallOrder[0]).toBeLessThan(
        requireValue(service.serviceStop.mock.invocationCallOrder[0], "Git service stop order"),
      );
      expect(freshRestartCalls()).toHaveLength(0);
    },
  );
});
