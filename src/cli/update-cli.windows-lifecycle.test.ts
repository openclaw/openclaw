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
import { registerSignalExitGate, waitForCliSignalExit } from "./signal-exit-barrier.js";
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
  gatewayFixturePid,
  readPackageVersion,
  resumeScheduledTaskAutoStartAfterUpdate,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStop,
  suspendScheduledTaskAutoStartForUpdate,
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
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  runCommandWithTimeout,
  runDaemonRestart,
  runUpdateFailureTriage,
  updateCommand,
  updateFinalizeCommand,
  updateGitRelease,
} from "./update-cli-modules.test-support.js";
import { registerFailureSelectorTests } from "./update-cli/update-cli-failure-recovery.test-support.js";
import {
  writeJsonFixture,
  writeNpmPackageInstall,
  writeOpenClawPackageFixture,
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

  registerWindowsTaskAdmissionTests(fixture);

  registerFailureSelectorTests({
    updateCommand,
    updateFinalizeCommand,
    updateGitRelease,
    readConfigFileSnapshot,
    profileStateDir: fixture.profileStateDir,
    runUpdateFailureTriage,
    expectSelectorTriageFailure,
  });

  it("does not inspect or mutate a Windows host service from an isolated install", async () => {
    const tempDir = fixture.tempDirs.make("openclaw-update-isolated-service-");
    const { nodeModules } = await fixture.setupInstalledPackageRoot(tempDir);
    fixture.mockRunningManagedGateway();
    fixture.mockFileBackedPathExists();
    fixture.mockNpmGlobalRoot(nodeModules);

    await withEnvAsync({ OPENCLAW_HOME: path.join(tempDir, "relocated-home") }, async () => {
      fixture.initializeExistingUpdateProfile();
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
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

  it("starts update triage when native stop-enable-committed preparation cannot restore task autostart", async () => {
    runtimeRecovery.stubNodeRuntime();
    fixture.setTty(true);
    fixture.setStdoutTty(true);
    const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-native-preparation");
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
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
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
      const action = scheduledTaskAction(argv);
      if (action === undefined) {
        return await configuredRunCommand(argv, options);
      }
      nativeCommands.push([...argv]);
      if (action === "/XML") {
        return commandResult({
          stdout: `<Task><Settings><Enabled>${taskEnabled}</Enabled></Settings></Task>`,
        });
      }
      if (action === "/DISABLE") {
        taskEnabled = false;
        return commandResult();
      }
      taskEnabled = true;
      return commandResult({ code: 1, stderr: "enable denied" });
    });
    serviceStop.mockRejectedValueOnce(new Error("listener cleanup failed after task stop"));
    const originalSignalListeners = process.listenerCount("SIGINT");
    triageCommand.mockImplementationOnce(async () => {
      expect(taskEnabled).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(originalSignalListeners);
    });
    const reportedError = await withEnvAsync(
      { OPENCLAW_HOME: undefined, OPENCLAW_SERVICE_REPAIR_POLICY: undefined },
      () => updateCommand({}),
    ).catch((error: unknown) => error);

    expect(
      nativeCommands.map(scheduledTaskAction),
      `${String(reportedError)}\n${getErrorOutput()}`,
    ).toEqual(["/XML", "/DISABLE", "/ENABLE", "/XML", "/DISABLE"]);
    expect(serviceStop).toHaveBeenCalledOnce();
    const nativeOrder = (action: string) => {
      const index = vi
        .mocked(runCommandWithTimeout)
        .mock.calls.findIndex(([argv]) => scheduledTaskAction(argv) === action);
      return requireValue(
        vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[index],
        `${action} order`,
      );
    };
    const stopOrder = requireValue(serviceStop.mock.invocationCallOrder[0], "service stop order");
    expect(nativeOrder("/DISABLE")).toBeLessThan(stopOrder);
    expect(stopOrder).toBeLessThan(nativeOrder("/ENABLE"));
    expect(packageInstallCommandCall()).toBeDefined();
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
      version: "1.0.0",
    });
    expect(serviceRestart).not.toHaveBeenCalled();
    expect(freshRestartCalls()).toEqual([]);
    expect(triageCommand).toHaveBeenCalledOnce();
    expect(reportedError).toEqual(new ExitError(1));
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    const recovery = triageCommand.mock.calls[0]?.[1]?.recovery;
    // Native preparation failed before a service stop or package activation;
    // triage retains the autostart error without claiming verified readiness.
    expect(recovery).toHaveProperty("updateFailure.result.verification", {});
    expect(recovery).toMatchObject({
      target,
      updateFailure: {
        result: {
          status: "error",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          steps: [
            expect.objectContaining({ name: "updater-runtime-retention", exitCode: 0 }),
            expect.objectContaining({ stderrTail: expect.stringContaining("enable denied") }),
            {
              name: "gateway recovery observation",
              command: "gateway verification",
              cwd: root,
              durationMs: 0,
              exitCode: 0,
              diagnostics: [expect.stringContaining("No service was stopped or started.")],
            },
          ],
        },
      },
    });
  });

  it("restores package files without re-enabling Windows autostart after interruption", async () => {
    await fixture.useFileBackedConfig();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
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
    await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
    await expect(waitForCliSignalExit()).resolves.toBe(130);
    expect(process.exitCode).toBe(130);
    expect(processExitSpy).not.toHaveBeenCalled();
    expect(resumeScheduledTaskAutoStartAfterUpdate.mock.calls.length).toBe(0);
    await fs.access(path.join(root, "dist", "index.js"));
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
        .mock.calls.some(([argv]) => scheduledTaskAction(argv) === "/ENABLE"),
    ).toBe(false);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  it.each([
    { signal: "SIGINT", phase: "package suspension" },
    { signal: "SIGINT", phase: "service pre-stop inspection" },
  ] as const)(
    "restores Windows Scheduled Task autostart on $signal during $phase",
    async ({ signal, phase }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const processOnSpy = vi.spyOn(process, "on");
      const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const gate = createDeferred();
      const entered = createDeferred();
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
      const root = await fixture.mockPackageInstallAtCaseDir("openclaw-update-suspension-signal");
      fixture.primeServiceCommand(
        [nodeExecutable, path.join(root, "dist", "index.js"), "gateway", "run"],
        { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
        resolveGatewayTaskScriptPath(process.env),
      );
      resumeScheduledTaskAutoStartAfterUpdate.mockImplementation(
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
      }).catch((cause: unknown) => {
        throw new Error(`${getLogOutput()}\n${getErrorOutput()}`, { cause });
      });
      // The executable retains the whole command, including unwind, before signal cleanup.
      const releaseCommandGate = registerSignalExitGate(updatePromise);
      void updatePromise.then(releaseCommandGate, releaseCommandGate);
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
        // Repeated signals reach every invocation-owned listener in registration order.
        for (const listener of signalListeners.concat(signalListeners)) {
          listener();
        }
        expect(processExitSpy).not.toHaveBeenCalled();
        expect(resumeScheduledTaskAutoStartAfterUpdate).not.toHaveBeenCalled();
        gate.resolve();
        await updatePromise;
        await expect(waitForCliSignalExit()).resolves.toBe(130);
        expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
        expect(serviceStop).not.toHaveBeenCalled();
        expect(packageInstallCommandCall()).toBeDefined();
        expect(freshRestartCalls()).toEqual([]);
        expect(listUpdateRuns({ limit: 1 })).toMatchObject([
          { phase: "finished", status: "skipped", reason: "cancelled" },
        ]);
        expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
        expect(process.exitCode).toBe(130);
        expect(processExitSpy).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        // The try body observes command errors; cleanup joins work before signal finalization.
        await Promise.allSettled([updatePromise]);
        await waitForCliSignalExit();
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

    await updateCommand({ yes: true, restart: false }).catch((cause: unknown) => {
      throw new Error(`${getLogOutput()}\n${getErrorOutput()}`, { cause });
    });

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
});
