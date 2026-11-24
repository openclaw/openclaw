import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  expectNoSideEffects,
  freshRestartCalls,
  getLogOutput,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStop,
  suspendScheduledTaskAutoStartForUpdate,
  windowsOfflineProbe,
} from "./update-cli-mocks.test-support.js";
import {
  ExitError,
  defaultRuntime,
  expectSelectorTriageFailure,
  fetchNpmPackageTargetStatus,
  invokeUpdateCli,
  readConfigFileSnapshot,
  runCommandWithTimeout,
  runDaemonRestart,
  runUpdateFailureTriage,
  updateCommand,
  updateFinalizeCommand,
  updateGitRelease,
} from "./update-cli-modules.test-support.js";
import { registerFailureSelectorTests } from "./update-cli/update-cli-failure-recovery.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";
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
