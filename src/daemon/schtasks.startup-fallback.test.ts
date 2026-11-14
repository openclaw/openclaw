import "./schtasks.startup-fallback-mocks.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, vi } from "vitest";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
} from "../infra/windows-install-roots.js";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import {
  resolveTaskScriptPath,
  queueNativeResponses,
  readScheduledTaskRuntime,
  readWindowsStartupFallbackRuntimeForUpdate,
  removeStartupEntries,
  INSTALLED_GATEWAY_COMMAND,
  OTHER_GATEWAY_COMMAND,
  POWERSHELL_PROCESS,
  addMissingTaskInstallResponses,
  addSuccessfulMigrationResponses,
  addSuccessfulScheduledTaskRestartResponses,
  childUnref,
  expectGatewayTermination,
  expectMissing,
  expectNoGatewayTermination,
  expectStartupFallbackSpawn,
  fastForwardTaskStartWait,
  holdQueuedTaskProbesUntilRunCount,
  installGateway,
  it,
  mockProcesses,
  mockTerminatingProcess,
  portUsage,
  processEntry,
  processListener,
  readScript,
  spawn,
  spawnSync,
  successfulResponses,
  taskProbe,
  verifiedGatewayPids,
  writeGatewayFallback,
  writeGatewayPackageCommand,
  writeRunningGatewayScript,
} from "./schtasks.startup-fallback-fixture.test-support.js";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";
import {
  notYetRunTaskSnapshot,
  runningTaskSnapshot,
  inspectPortUsageMock,
  isProcessSnapshotQuery,
  makeSpawnSyncResult,
  resolveStartupFixturePath,
  schtasksResponses,
  writeStartupFallbackEntry,
} from "./test-helpers/schtasks-fixtures.js";

describe("Windows startup fallback", () => {
  it("probes missing tasks without locale or parent-env leakage", async ({ env }) => {
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    taskProbe.mockReturnValue({ status: 1, stdout: "-2147024894" });
    await expect(readScheduledTaskRuntime(env)).resolves.toEqual({
      status: "stopped",
      missingUnit: true,
    });
    expect(taskProbe).toHaveBeenCalledOnce();
    expect(taskProbe.mock.calls[0]?.[2]).toMatchObject({
      env: expect.not.objectContaining({ BOUNDARY_PARENT_ONLY: "synthetic" }),
      timeout: 60_000,
    });
  });

  it("redacts paths from login item removal failures", async ({ env }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    const removalError = Object.assign(
      new Error(`EACCES: permission denied, unlink '${startupEntryPath}'`),
      { code: "EACCES", path: startupEntryPath },
    );
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(removalError);

    const removal = removeStartupEntries(env, new PassThrough());

    await expect(removal).rejects.toThrow("Windows login item removal failed (EACCES)");
    await expect(removal).rejects.not.toThrow(startupEntryPath);
    const sanitizedError = await removal.catch((error: unknown) => error);
    expect(sanitizedError).toBeInstanceOf(Error);
    if (!(sanitizedError instanceof Error)) {
      throw new Error("expected sanitized Windows login item removal failure");
    }
    expect(sanitizedError).not.toBe(removalError);
    expect(sanitizedError.cause).toEqual({ code: "EACCES" });
    expect(sanitizedError).not.toHaveProperty("path");
    expect(sanitizedError.stack).not.toContain(startupEntryPath);
    await fs.access(startupEntryPath);
  });

  it("skips task ownership probes when no Startup fallback exists", async ({ env }) => {
    await expect(readWindowsStartupFallbackRuntimeForUpdate(env)).resolves.toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("rejects update-owned fallback before publication", async ({ env }) => {
    addMissingTaskInstallResponses([{ code: 5, stdout: "", stderr: "ERROR: Access is denied." }]);
    await expect(
      withGatewayServiceUpdateAuthority(
        () => {},
        () => installGateway(env),
      ),
    ).rejects.toThrow("startup fallback is unsupported");
    await expectMissing(resolveStartupFixturePath(env));
    expect(spawn).not.toHaveBeenCalled();
  });

  it.for(["cmd", "vbs"] as const)(
    "installs a %s Startup launcher after denied Scheduled Task creation",
    async (format, { env }) => {
      const hidden = format === "vbs";
      addMissingTaskInstallResponses([
        {
          code: hidden ? 5 : 1,
          stdout: "",
          stderr: hidden ? "ERROR: Access is denied." : "错误: 拒绝访问。",
        },
      ]);
      const result = await installGateway(
        hidden ? { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" } : env,
      );
      const raw = await fs.readFile(resolveStartupFixturePath(env, format));
      const script = decodeWindowsLauncherScript({ buffer: raw });
      expect(result.scriptPath).toBe(resolveTaskScriptPath(env));
      expect(script).toContain("gateway.cmd");
      if (hidden) {
        // wscript requires the BOM; UTF-16 preserves CJK paths.
        expect(raw.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
        expect(script).toContain("WScript.Shell");
        expect(script).toContain(`WScript.Quit shell.Run("""${result.scriptPath}""", 0, True)`);
      } else {
        expect(script).toContain(`start "" /min ${getWindowsCmdExePath()} /d /c`);
      }
      expectStartupFallbackSpawn();
      expect(childUnref).toHaveBeenCalled();
    },
  );

  it("removes both Startup formats after migration", async ({ env }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    const hiddenStartupEntryPath = await writeStartupFallbackEntry(env, "vbs");
    addSuccessfulMigrationResponses();

    await installGateway(env);

    await expectMissing(startupEntryPath);
    await expectMissing(hiddenStartupEntryPath);
  });

  it("settles takeover after Startup vanishes during readiness", async ({ env }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    await writeRunningGatewayScript(env, 4242, () => true, " --task-supervisor-child=305419896");
    verifiedGatewayPids.mockReturnValue([4242]);
    inspectPortUsageMock
      .mockImplementationOnce(async (port) => {
        await fs.unlink(startupEntryPath);
        return portUsage("free", [], port);
      })
      .mockResolvedValue(portUsage("free"));
    addMissingTaskInstallResponses([
      ...successfulResponses(2),
      runningTaskSnapshot(),
      ...successfulResponses(2),
    ]);
    const progress = notYetRunTaskSnapshot("2026-04-15T23:42:31.0000000Z");
    queueNativeResponses(notYetRunTaskSnapshot(), progress, runningTaskSnapshot());
    holdQueuedTaskProbesUntilRunCount(2);
    await expect(installGateway(env)).resolves.toEqual({
      scriptPath: resolveTaskScriptPath(env),
    });

    expectGatewayTermination(4242);
    expect(spawn).not.toHaveBeenCalled();
    expect(schtasksResponses).toEqual([]);
    await expectMissing(startupEntryPath);
  });

  it("rejects takeover without process identity", async ({ env }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    verifiedGatewayPids.mockReturnValue([4242]);
    spawnSync.mockImplementation((command, args) => {
      if (command === getWindowsPowerShellExePath() && isProcessSnapshotQuery(args)) {
        return makeSpawnSyncResult({ status: 1 });
      }
      if (command.endsWith("tasklist.exe")) {
        return makeSpawnSyncResult({
          stdout: '"node.exe","4242","Console","1","1,024 K"',
        });
      }
      return makeSpawnSyncResult();
    });

    await expect(installGateway(env)).rejects.toThrow("could not verify the installed process");

    expect(spawnSync.mock.calls.some(([command]) => command.endsWith("taskkill.exe"))).toBe(false);
    await fs.access(startupEntryPath);
  });

  it("accepts an exit race without forcing a stale PID", async ({ env }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    mockTerminatingProcess(INSTALLED_GATEWAY_COMMAND, 4242, 128);

    addSuccessfulMigrationResponses();
    holdQueuedTaskProbesUntilRunCount(2);

    await installGateway(env);

    const forcedCalls = spawnSync.mock.calls.filter(
      ([command, args]) =>
        command.endsWith("taskkill.exe") && Array.isArray(args) && args.includes("/F"),
    );
    expect(forcedCalls).toHaveLength(0);
    await expectMissing(startupEntryPath);
  });

  it("rejects migration across gateway installations", async ({ env, tmpDir }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    const commandLine = await writeGatewayPackageCommand(path.join(tmpDir, "other-install"));
    mockProcesses(() => [
      processEntry(3131, "C:\\manual\\openclaw.cmd gateway --port 18789"),
      processEntry(4242, commandLine),
      POWERSHELL_PROCESS,
    ]);

    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [{ pid: 4242, command: "node.exe", commandLine }]),
    );

    await expect(installGateway(env)).rejects.toThrow(
      "gateway listener on port 18789 does not match the persisted command",
    );

    expectNoGatewayTermination();
    await fs.access(startupEntryPath);
  });

  it("restores fallback after rejected takeover Run", async ({ env }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    await writeRunningGatewayScript(env, 4242);
    verifiedGatewayPids.mockReturnValue([4242]);
    let portInspections = 0;
    inspectPortUsageMock.mockImplementation(async (port) => {
      return portInspections++ === 0
        ? portUsage("busy", [{ pid: 4242, command: "node.exe" }], port)
        : portUsage("free", [], port);
    });
    addMissingTaskInstallResponses([
      ...successfulResponses(2),
      runningTaskSnapshot(),
      { code: 0, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "restart denied" },
    ]);

    await expect(installGateway(env)).rejects.toThrow("schtasks run failed: restart denied");

    expectGatewayTermination(4242);
    expectStartupFallbackSpawn();
    await fs.access(startupEntryPath);
  });

  it.for(["busy", "unknown"] as const)(
    "preserves the fallback definition when the replacement port is %s",
    async (status, { env }) => {
      const startupEntryPath = await writeGatewayFallback(env);
      const scriptPath = resolveTaskScriptPath(env);
      const before = await readScript(scriptPath);
      env.OPENCLAW_GATEWAY_PORT = "19433";
      mockProcesses(() => [
        status === "busy" ? processEntry(5252, OTHER_GATEWAY_COMMAND) : processEntry(4242),
        POWERSHELL_PROCESS,
      ]);
      inspectPortUsageMock.mockImplementation(async (port) =>
        status === "unknown"
          ? portUsage("unknown", [], 19433)
          : port === 19433
            ? portUsage("busy", [processListener(5252, OTHER_GATEWAY_COMMAND)], port)
            : portUsage("free", [], port),
      );
      await expect(installGateway(env, new PassThrough(), "19433")).rejects.toThrow(
        status === "busy"
          ? "replacement gateway port 19433 is occupied by an unverified process"
          : "Could not verify replacement gateway port 19433",
      );
      expect(await readScript(scriptPath)).toBe(before);
      await fs.access(startupEntryPath);
    },
  );

  it.for(["not launched", "not observable"] as const)(
    "does not relaunch a fallback after an accepted takeover is %s",
    async (failure, { env }) => {
      const startupEntryPath = await writeGatewayFallback(env);
      if (failure === "not launched") {
        mockTerminatingProcess();
        inspectPortUsageMock
          .mockResolvedValueOnce(portUsage("busy", [{ pid: 4242, command: "node.exe" }]))
          .mockResolvedValue(portUsage("free"));
      } else {
        let processQueries = 0;
        mockProcesses(() => [
          ...(++processQueries < 3 ? [processEntry(4242)] : []),
          POWERSHELL_PROCESS,
        ]);
      }
      fastForwardTaskStartWait();
      addMissingTaskInstallResponses([...successfulResponses(2), runningTaskSnapshot()]);
      if (failure === "not launched") {
        queueNativeResponses(
          ...successfulResponses(2),
          notYetRunTaskSnapshot(),
          notYetRunTaskSnapshot(),
        );
      } else {
        addSuccessfulScheduledTaskRestartResponses([notYetRunTaskSnapshot()], {
          ...notYetRunTaskSnapshot(),
          state: 2,
        });
      }
      holdQueuedTaskProbesUntilRunCount(2);
      await expect(installGateway(env)).rejects.toThrow("refusing a direct fallback");
      expect(spawn).not.toHaveBeenCalled();
      await fs.access(startupEntryPath);
    },
  );

  it("re-probes the captured port after config reload", async ({ env }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    let oldPortProbes = 0;
    await writeRunningGatewayScript(env, 4242, () => oldPortProbes >= 3);
    env.OPENCLAW_GATEWAY_PORT = "19433";
    inspectPortUsageMock.mockImplementation(async (port) => {
      if (port !== 18789) {
        return portUsage("free", [], port);
      }
      oldPortProbes += 1;
      return oldPortProbes < 3
        ? portUsage("free", [], port)
        : portUsage(
            "busy",
            [processListener(4242, 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789')],
            port,
          );
    });
    addSuccessfulMigrationResponses();
    holdQueuedTaskProbesUntilRunCount(2);

    await installGateway(env, new PassThrough(), "19433", {
      status: "running",
      pid: 4242,
    });

    expect(oldPortProbes).toBeGreaterThanOrEqual(3);
    expectGatewayTermination(4242);
    await expectMissing(startupEntryPath);
  });

  it("keeps fallback until the previous process is proven gone", async ({ env }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    inspectPortUsageMock.mockResolvedValue(portUsage("free"));

    await expect(
      installGateway(env, new PassThrough(), "18789", { status: "running" }),
    ).rejects.toThrow("previously running Windows login item has not exited cleanly");
    await fs.access(startupEntryPath);
  });
});
