import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import {
  expectNoSideEffects,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  databasePreflightMocks,
  gatewayFixturePid,
  readPackageVersion,
  resumeScheduledTaskAutoStartAfterUpdate,
  serviceLoaded,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  suspendScheduledTaskAutoStartForUpdate,
  triageAfterFailure,
  windowsOfflineProbe,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  listUpdateRuns,
  makeOkUpdateResult,
  readConfigFileSnapshot,
  runCommandWithTimeout,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  writeNpmPackageInstall,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    createCaseDir,
    fixtureRoot,
    mockFileBackedPathExists,
    mockNpmGlobalCommands,
    mockOwnedGitService,
    mockPackageInstallAtCaseDir,
    mockRunningManagedGateway,
    primeNpmChannelTag,
    primeServiceCommand,
    setupInstalledPackageRoot,
    tempDirs,
    useNativeScheduledTaskControl,
  } = createUpdateCliFixture();

  it.each(["interrupted", "settling", "completed"] as const)(
    "refuses mutation through a %s Windows task recovery owner",
    async (outcome) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const processOnSpy = vi.spyOn(process, "on");
      const exitCalled = createDeferred();
      const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        exitCalled.resolve();
        return undefined as never;
      });
      const { maybeStopManagedServiceBeforeMutableUpdate, UpdateCommandAbort } =
        await import("./update-cli/update-command-service.js");
      mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
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
        if (outcome === "interrupted") {
          const listener = processOnSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
          if (typeof listener !== "function") {
            throw new Error("missing task recovery signal handler");
          }
          listener();
        } else {
          await recovery.restore();
          const completion = recovery.complete();
          if (outcome === "completed") {
            await completion;
          }
        }
        expect(() => recovery.beginMutation()).toThrow(UpdateCommandAbort);
      } finally {
        await recovery.restore();
        await recovery.complete();
        if (outcome === "interrupted") {
          await exitCalled.promise;
          expect(processExitSpy).toHaveBeenCalledWith(130);
        }
        platformSpy.mockRestore();
        processOnSpy.mockRestore();
        processExitSpy.mockRestore();
      }
      expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

  it.each([
    { verified: true, compensationFails: false },
    { verified: false, compensationFails: false },
    { verified: false, compensationFails: true },
  ])(
    "settles restored Windows autostart after verification=$verified (compensation failure=$compensationFails)",
    async ({ verified, compensationFails }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
      await useNativeScheduledTaskControl();
      const runFixture = requireValue(
        vi.mocked(runCommandWithTimeout).getMockImplementation(),
        "managed task command fixture",
      );
      let enabled = true;
      const mutations: string[] = [];
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[0] !== "schtasks") {
          return await runFixture(argv, options);
        }
        if (argv[1] === "/Query") {
          return commandResult({
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
          });
        }
        const action = argv.at(-1)!;
        mutations.push(action);
        enabled = action === "/ENABLE";
        return compensationFails && mutations.length === 3
          ? commandResult({ code: 124, stderr: "disable timed out after commit" })
          : commandResult();
      });
      const {
        maybeStopManagedServiceBeforeMutableUpdate,
        maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
      } = await import("./update-cli/update-command-service.js");
      const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
      });
      const recovery = requireValue(stopped.windowsTaskAutoStartRecovery, "task suspension");
      try {
        recovery.beginMutation();
        await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(stopped, true);
        expect(enabled).toBe(true);
        expect(stopped.windowsTaskAutoStartRecovery).toBe(recovery);
        if (compensationFails) {
          await expect(recovery.complete(verified)).rejects.toThrow(
            "disable timed out after commit",
          );
        } else {
          await recovery.complete(verified);
        }
        expect(enabled).toBe(verified);
        await recovery.complete();
        await recovery.restore(true);
        expect(mutations).toEqual(
          verified ? ["/DISABLE", "/ENABLE"] : ["/DISABLE", "/ENABLE", "/DISABLE"],
        );
      } finally {
        await recovery.complete(false);
      }
    },
  );

  it("does not restore autostart on a pinned Windows task replaced during service stop", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
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
      primeServiceCommand(["node", "/another-install/openclaw.mjs", "gateway", "run"]);
      throw new Error("stop failed after task replacement");
    });
    try {
      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({ ...params, expectedService }),
      ).rejects.toThrow("restore Windows Scheduled Task autostart");
    } finally {
      platformSpy.mockRestore();
    }
    expect(serviceStop).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(runCommandWithTimeout)
        .mock.calls.some(([argv]) => argv[0] === "schtasks" && argv.includes("/ENABLE")),
    ).toBe(false);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  it.each(
    (["SIGINT", "SIGBREAK"] as const).flatMap((signal) =>
      (["package suspension", "Git schema preflight"] as const).map((phase) => ({ signal, phase })),
    ),
  )(
    "restores Windows Scheduled Task autostart on $signal during $phase",
    async ({ signal, phase }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
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
        mockOwnedGitService();
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
        const root = await mockPackageInstallAtCaseDir("openclaw-update-suspension-signal");
        primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
        });
      }
      resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });

      const updatePromise = updateCommand({ yes: true, restart: false });
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
        expect(Boolean(packageInstallCommandCall())).toBe(phase === "package suspension");
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
        platformSpy.mockRestore();
        processOnSpy.mockRestore();
        processExitSpy.mockRestore();
      }
    },
  );

  it.each(["running", "stopped"] as const)(
    "guards a %s Windows Scheduled Task during a no-restart package update",
    async (runtimeStatus) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(fixtureRoot);
      const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageRoot(
        createCaseDir("openclaw-update-stopped-task"),
      );
      primeNpmChannelTag("latest", "2026.4.22");
      mockFileBackedPathExists();
      readPackageVersion.mockResolvedValue("2026.4.21");
      mockNpmGlobalCommands(nodeModules, async (argv) => {
        if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
          await writeNpmPackageInstall(argv, pkgRoot, "2026.4.22");
        }
      });
      primeServiceCommand(["node", entryPath, "gateway", "run"], {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      });
      serviceReadRuntime.mockResolvedValue(
        runtimeStatus === "running"
          ? { status: "running", state: "running", pid: gatewayFixturePid }
          : { status: "stopped", state: "stopped" },
      );
      suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
      resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);

      try {
        await updateCommand({ yes: true, restart: false });
      } catch (cause) {
        throw new Error(`${getLogOutput()}\n${getErrorOutput()}`, { cause });
      } finally {
        homeSpy.mockRestore();
        platformSpy.mockRestore();
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
    },
  );

  it.each(["running", "stopped"])(
    "does not suspend a %s foreign source-checkout Windows task when offline inspection is unavailable",
    async (runtimeStatus) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const updateRoot = tempDirs.make("openclaw-update-foreign-task-");
      const foreignRoot = tempDirs.make("openclaw-update-foreign-task-owner-");
      const foreignEntrypoint = await writeOpenClawPackageFixture(foreignRoot, "2026.4.21", {
        entrySource: "export {};\n",
      });
      await Promise.all(
        [".git", "src", "extensions"].map((directory) =>
          fs.mkdir(path.join(foreignRoot, directory)),
        ),
      );
      primeServiceCommand(["node", foreignEntrypoint, "gateway", "run"]);
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({
        status: runtimeStatus,
        state: runtimeStatus,
        ...(runtimeStatus === "running" ? { pid: gatewayFixturePid } : {}),
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
          running: runtimeStatus === "running",
          offline: false,
          serviceUpdateVerdict: { kind: "foreign" },
        });
      } finally {
        windowsOfflineProbe.mockReset().mockResolvedValue(null);
        platformSpy.mockRestore();
      }

      expect(suspendScheduledTaskAutoStartForUpdate.mock.calls.length).toBe(0);
      expect(resumeScheduledTaskAutoStartAfterUpdate.mock.calls.length).toBe(0);
      expect(serviceStop.mock.calls.length).toBe(0);
    },
  );

  it.each(["doctor failure", "post-core exception"] as const)(
    "keeps Windows Git task autostart disabled after %s",
    async (failureKind) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
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

      try {
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
      } finally {
        platformSpy.mockRestore();
      }
    },
  );
});
