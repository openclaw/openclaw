import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it as baseIt, vi } from "vitest";
import type { PortUsage } from "../infra/ports-types.js";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
} from "../infra/windows-install-roots.js";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import "./test-helpers/schtasks-base-mocks.js";
import { readWindowsStartupFallbackRuntimeForUpdate } from "./schtasks-runtime.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";

vi.mock("../infra/windows-encoding.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/windows-encoding.js")>(
    "../infra/windows-encoding.js",
  );
  return {
    ...actual,
    resolveWindowsOemCodePage: () => 437,
    resolveWindowsOemEncoding: () => "cp437",
  };
});

import {
  createSpawnChild,
  inspectPortUsageMock,
  killProcessTreeMock,
  makeSpawnSyncResult,
  resetSchtasksBaseMocks,
  resolveStartupFixturePath,
  schtasksCalls,
  schtasksResponses,
  withWindowsEnv,
  writeGatewayScript,
  writeNodeScript,
  writeStartupFallbackEntry,
  type SpawnSyncResult,
} from "./test-helpers/schtasks-fixtures.js";

type WindowsFixture = Parameters<Parameters<typeof withWindowsEnv>[1]>[0];
const it = baseIt.extend<WindowsFixture & { windows: WindowsFixture }>({
  windows: async ({ task }, use) => {
    await withWindowsEnv(`openclaw-win-startup-${task.id}-`, use);
  },
  env: async ({ windows }, use) => use(windows.env),
  tmpDir: async ({ windows }, use) => use(windows.tmpDir),
});

const timeState = vi.hoisted(() => ({ now: 0 }));
const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    timeState.now += ms;
  }),
);
const childUnref = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn());
const spawnSync = vi.hoisted(() =>
  vi.fn<(command: string, args?: readonly string[], options?: SpawnSyncOptions) => SpawnSyncResult>(
    () => ({
      pid: 0,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    }),
  ),
);
type TaskProbeResult = { status: number; stdout: string; stderr?: string };
const taskProbeResponses: TaskProbeResult[] = [];
const taskProbe = vi.hoisted(() =>
  vi.fn<
    (command: string, args?: readonly string[], options?: SpawnSyncOptions) => TaskProbeResult
  >(),
);

const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleepMock(ms),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn,
    spawnSync: (command: string, args?: readonly string[], options?: SpawnSyncOptions) => {
      const encoded = args?.indexOf("-EncodedCommand") ?? -1;
      if (
        encoded >= 0 &&
        Buffer.from(args?.[encoded + 1] ?? "", "base64")
          .toString("utf16le")
          .includes("Schedule.Service")
      ) {
        return taskProbe(command, args, options);
      }
      return spawnSync(command, args, options);
    },
  };
});
vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
}));

const {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskRuntime,
  restartScheduledTask,
  resolveTaskScriptPath,
  stopScheduledTask,
  uninstallScheduledTask,
} = await import("./schtasks.js");
const { removeStartupEntries } = await import("./schtasks-runtime.js");
const { createMockGatewayService } = await import("./service.test-helpers.js");
const { readServiceStatusSummary } = await import("../commands/status.service-summary.js");
const { getStatusOverviewRowValue } = await import("../commands/status.test-support.ts");

const NODE_PROCESS_QUERY =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
const STARTUP_GATEWAY_COMMAND =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789';

const INSTALLED_GATEWAY_COMMAND =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789';
const OTHER_GATEWAY_COMMAND =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\dist\\index.js" gateway --port 19433';
const NODE_HOST_COMMAND = "C:\\bin\\openclaw.cmd node run --host 127.0.0.1 --port 18789";
const POWERSHELL_PROCESS = { ProcessId: 9999, CommandLine: "powershell.exe" };

function processEntry(ProcessId: number, CommandLine = INSTALLED_GATEWAY_COMMAND) {
  return { ProcessId, CommandLine };
}

function mockProcesses(
  read: () => ReturnType<typeof processEntry>[],
  onTaskkill?: () => SpawnSyncResult,
): void {
  spawnSync.mockImplementation((command, args) => {
    if (command === getWindowsPowerShellExePath() && args?.includes(NODE_PROCESS_QUERY)) {
      return makeSpawnSyncResult({ stdout: JSON.stringify(read()) });
    }
    return command.endsWith("taskkill.exe")
      ? (onTaskkill?.() ?? makeSpawnSyncResult())
      : makeSpawnSyncResult();
  });
}

function mockTerminatingProcess(command = INSTALLED_GATEWAY_COMMAND, pid = 4242, status = 0): void {
  let alive = true;
  mockProcesses(
    () => [...(alive ? [processEntry(pid, command)] : []), POWERSHELL_PROCESS],
    () => {
      alive = false;
      return makeSpawnSyncResult({ status });
    },
  );
}

async function writeGatewayPackageCommand(root: string): Promise<string> {
  const entry = path.join(root, "dist", "index.js");
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.writeFile(entry, "export {};\n");
  return `"${process.execPath}" "${entry}" gateway --port 18789`;
}

async function writeTaskCommand(env: Record<string, string>, command: string) {
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(
    scriptPath,
    ["@echo off", 'set "OPENCLAW_GATEWAY_PORT=18789"', command, ""].join("\r\n"),
    "utf8",
  );
  return scriptPath;
}

async function writeGatewayFallback(env: Record<string, string>) {
  const startupEntryPath = await writeStartupFallbackEntry(env);
  await writeGatewayScript(env);
  return startupEntryPath;
}

async function writeRunningGatewayScript(
  env: Record<string, string>,
  processId: number,
  isRunning = () => true,
  processSuffix = "",
) {
  await writeTaskCommand(env, STARTUP_GATEWAY_COMMAND);
  let terminated = false;
  spawnSync.mockImplementation((command, args) => {
    if (args?.some((arg) => arg.includes(".StartTime"))) {
      return makeSpawnSyncResult({ stdout: "2026-09-27T00:00:00Z" });
    }
    if (command.endsWith("tasklist.exe")) {
      return makeSpawnSyncResult({
        stdout: !terminated && isRunning() ? `"node.exe","${processId}","Console","1","1 K"` : "",
      });
    }
    if (command === getWindowsPowerShellExePath() && args?.includes(NODE_PROCESS_QUERY)) {
      return makeSpawnSyncResult({
        stdout: JSON.stringify([
          ...(!terminated && isRunning()
            ? [{ ProcessId: processId, CommandLine: STARTUP_GATEWAY_COMMAND + processSuffix }]
            : []),
          { ProcessId: 9999, CommandLine: "powershell.exe" },
        ]),
      });
    }
    if (command.endsWith("taskkill.exe") && args?.includes(String(processId))) {
      terminated = true;
    }
    return makeSpawnSyncResult();
  });
}

function makeNodeServiceEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    OPENCLAW_SERVICE_KIND: "node",
    OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
  };
}

function processListener(pid: number, commandLine: string, command = "node.exe") {
  return { pid, command, commandLine };
}

function portUsage(
  status: PortUsage["status"],
  listeners: PortUsage["listeners"] = [],
  port = 18789,
): PortUsage {
  return { port, status, listeners, hints: [] };
}

function expectTaskkillPid(pid: number): void {
  expect(
    spawnSync.mock.calls.some(
      ([command, args]) =>
        command.endsWith("taskkill.exe") &&
        Array.isArray(args) &&
        args.includes("/PID") &&
        args.includes(String(pid)),
    ),
  ).toBe(true);
}

function expectStartupFallbackSpawn() {
  expect(spawn).toHaveBeenLastCalledWith(
    expect.not.stringMatching(/^cmd\.exe$/u),
    expect.arrayContaining(["--port", "18789"]),
    expect.objectContaining({
      detached: true,
      env: expect.objectContaining({ OPENCLAW_GATEWAY_PORT: "18789" }),
      stdio: "ignore",
      windowsHide: true,
    }),
  );
}

function expectGatewayTermination(pid: number) {
  expectTaskkillPid(pid);
  expect(killProcessTreeMock).not.toHaveBeenCalled();
}

function expectNoGatewayTermination() {
  expect(killProcessTreeMock).not.toHaveBeenCalled();
  expect(spawnSync.mock.calls.filter(([command]) => command.endsWith("taskkill.exe"))).toEqual([]);
}

function successfulResponses(count: number): (typeof schtasksResponses)[number][] {
  return Array.from({ length: count }, () => ({ code: 0, stdout: "", stderr: "" }));
}

function addMissingTaskInstallResponses(responses: NativeResponse[]): void {
  taskProbe.mockReturnValueOnce({ status: 1, stdout: "-2147024894" });
  queueNativeResponses(
    { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." },
    ...responses.flatMap((response, index) =>
      index === 0 && "code" in response && response.code === 0
        ? [response, { code: 0, stdout: "", stderr: "" }]
        : [response],
    ),
  );
}

function addStartupFallbackMissingResponses(extraResponses: NativeResponse[] = []) {
  queueNativeResponses({ code: 0, stdout: "", stderr: "" });
  addMissingTaskInstallResponses(extraResponses);
}

function installGatewayScheduledTask(
  env: Record<string, string>,
  stdout = new PassThrough(),
  port = "18789",
  startupFallbackTakeoverRuntime?: GatewayServiceRuntime,
) {
  return installScheduledTask({
    env,
    stdout,
    programArguments: ["node", "gateway.js", "--port", port],
    environment: { OPENCLAW_GATEWAY_PORT: port },
    startupFallbackTakeoverRuntime,
  });
}

function installNodeScheduledTask(env: Record<string, string>, stdout = new PassThrough()) {
  return installScheduledTask({
    env: {
      ...env,
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
    },
    stdout,
    programArguments: ["node", "openclaw", "node", "run", "--host", "127.0.0.1", "--port", "18789"],
    environment: {
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_GATEWAY_PORT: "18789",
    },
  });
}

function fastForwardTaskStartWait(): void {
  sleepMock.mockImplementationOnce(async () => {
    timeState.now += 15_000;
  });
}

function addAcceptedRunNeverStartsResponses(): void {
  addMissingTaskInstallResponses([
    ...successfulResponses(2),
    notYetRunTaskSnapshot(),
    notYetRunTaskSnapshot(),
  ]);
}

function addSuccessfulScheduledTaskRestartResponses(
  cleanupEvidence: TaskSnapshot[] = [runningTaskSnapshot()],
  launchEvidence = runningTaskSnapshot(),
): void {
  queueNativeResponses(...successfulResponses(4), launchEvidence, ...cleanupEvidence);
}

function addSuccessfulMigrationResponses(): void {
  addMissingTaskInstallResponses([
    ...successfulResponses(2),
    runningTaskSnapshot(),
    runningTaskSnapshot(),
  ]);
  addSuccessfulScheduledTaskRestartResponses();
}

type TaskSnapshot = { state: number; lastRunTime: string; lastRunResult: number };
type NativeResponse = (typeof schtasksResponses)[number] | TaskSnapshot;

function queueNativeResponses(...responses: NativeResponse[]): void {
  for (const response of responses) {
    if ("state" in response) {
      taskProbeResponses.push({ status: 0, stdout: JSON.stringify(response) });
    } else {
      schtasksResponses.push(response);
    }
  }
}

function notYetRunTaskSnapshot(lastRunTime = "1999-11-30T00:00:00.0000000Z"): TaskSnapshot {
  return { state: 3, lastRunTime, lastRunResult: 267011 };
}

function cleanExitTaskSnapshot(lastRunTime = "2026-05-02T14:41:39.0000000Z"): TaskSnapshot {
  return { state: 3, lastRunTime, lastRunResult: 0 };
}

function runningTaskSnapshot(): TaskSnapshot {
  return { state: 4, lastRunTime: "2026-04-15T23:42:31.0000000Z", lastRunResult: 267009 };
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  taskProbeResponses.length = 0;
  taskProbe.mockReset();
  taskProbe.mockImplementation(
    () => taskProbeResponses.shift() ?? { status: 0, stdout: '{"state":0}' },
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
  inspectPortUsageMock.mockResolvedValue(portUsage("free"));
  spawn.mockReset();
  spawn.mockImplementation(() => createSpawnChild(childUnref));
  spawnSync.mockReset();
  spawnSync.mockImplementation((command, args) =>
    command === getWindowsPowerShellExePath() && args?.includes(NODE_PROCESS_QUERY)
      ? makeSpawnSyncResult({
          stdout: JSON.stringify([{ ProcessId: 9999, CommandLine: "powershell.exe" }]),
        })
      : makeSpawnSyncResult(),
  );
  childUnref.mockClear();
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Windows startup fallback", () => {
  it("uses the locale-independent task probe when a scheduled task is missing", async () => {
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
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
  });

  it("normalizes unexpected scheduled-task failures through the shared status summary", async ({
    env,
  }) => {
    await writeStartupFallbackEntry(env);
    const detail = "-2147024891";
    taskProbe.mockReturnValue({ status: 1, stdout: "-2147024891" });

    const summary = await readServiceStatusSummary(
      createMockGatewayService({
        label: "Scheduled Task",
        loadedText: "registered",
        notLoadedText: "missing",
        readRuntime: () => readScheduledTaskRuntime(env),
      }),
      "Daemon",
    );

    expect(summary.runtime).toEqual({
      status: "unknown",
      detail: "service runtime inspection failed",
      inspectionFailure: {
        code: "service-runtime-inspection-failed",
        detail: "Scheduled Task probe failed (exit 1): -2147024891",
      },
      missingUnit: false,
    });
    expect(getStatusOverviewRowValue("Gateway service", { gatewayService: summary })).toBe(
      "Scheduled Task missing (inspection failed: service runtime inspection failed) · unknown",
    );
    expect(getStatusOverviewRowValue("Gateway service", { gatewayService: summary })).not.toContain(
      detail,
    );
  });

  it("reports login item removal failures without leaking the item path", async ({ env }) => {
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

  it("refuses update-owned Startup fallback before publishing a login item or detached launcher", async ({
    env,
  }) => {
    addMissingTaskInstallResponses([{ code: 5, stdout: "", stderr: "ERROR: Access is denied." }]);
    await expect(
      withGatewayServiceUpdateAuthority(
        () => {},
        () => installGatewayScheduledTask(env),
      ),
    ).rejects.toThrow("startup fallback is unsupported");
    await expect(fs.stat(resolveStartupFixturePath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("falls back to a Startup-folder launcher when schtasks create is denied in another locale", async ({
    env,
  }) => {
    addMissingTaskInstallResponses([{ code: 1, stdout: "", stderr: "错误: 拒绝访问。" }]);

    const stdout = new PassThrough();
    const result = await installGatewayScheduledTask(env, stdout);

    const startupEntryPath = resolveStartupFixturePath(env);
    const startupScript = decodeWindowsLauncherScript({
      buffer: await fs.readFile(startupEntryPath),
    });
    expect(result.scriptPath).toBe(resolveTaskScriptPath(env));
    expect(startupScript).toContain(`start "" /min ${getWindowsCmdExePath()} /d /c`);
    expect(startupScript).toContain("gateway.cmd");
    expectStartupFallbackSpawn();
    expect(childUnref).toHaveBeenCalled();
    const printed = String(stdout.read());
    expect(printed).toContain("Installed Windows login item");
  });

  it("uses a hidden Startup-folder launcher when requested", async ({ env }) => {
    addMissingTaskInstallResponses([{ code: 5, stdout: "", stderr: "ERROR: Access is denied." }]);

    const result = await installGatewayScheduledTask({
      ...env,
      OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
    });

    const startupEntryPath = resolveStartupFixturePath(env, "vbs");
    const rawStartupScript = await fs.readFile(startupEntryPath);
    const startupScript = decodeWindowsLauncherScript({ buffer: rawStartupScript });
    expect(result.scriptPath).toBe(resolveTaskScriptPath(env));
    // wscript only accepts UTF-16 LE with BOM or ANSI; UTF-16 keeps CJK paths intact.
    expect(rawStartupScript.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(startupScript).toContain("WScript.Shell");
    expect(startupScript).toContain("gateway.cmd");
    expect(startupScript).toContain(`WScript.Quit shell.Run("""${result.scriptPath}""", 0, True)`);
    expectStartupFallbackSpawn();
  });

  it("removes an old Startup-folder launcher after migrating to a Scheduled Task", async ({
    env,
  }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    const hiddenStartupEntryPath = await writeStartupFallbackEntry(env, "vbs");
    addSuccessfulMigrationResponses();

    const stdout = new PassThrough();
    await installGatewayScheduledTask(env, stdout);

    await expect(fs.access(startupEntryPath)).rejects.toThrow();
    await expect(fs.access(hiddenStartupEntryPath)).rejects.toThrow();
    const printed = String(stdout.read());
    expect(printed).toContain("Installed Scheduled Task");
    expect(printed).toContain("Removed Windows login item");
  });

  it("takes over the supervised Startup child after delayed readiness even if Startup was removed", async ({
    env,
  }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    await writeRunningGatewayScript(env, 4242, () => true, " --task-supervisor-child=305419896");
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
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
    queueNativeResponses(notYetRunTaskSnapshot(), progress, progress, runningTaskSnapshot());
    const stdout = new PassThrough();

    await expect(installGatewayScheduledTask(env, stdout)).resolves.toEqual({
      scriptPath: resolveTaskScriptPath(env),
    });

    expectGatewayTermination(4242);
    expect(spawn).not.toHaveBeenCalled();
    expect(schtasksResponses).toEqual([]);
    expect(sleepMock.mock.calls).toEqual([[250], [250]]);
    const printed = String(stdout.read());
    expect(printed).toContain("Restarted Scheduled Task");
    expect(printed).not.toContain("Removed Windows login item");
    await expect(fs.access(startupEntryPath)).rejects.toThrow();
  });

  it("migrates an exact persisted wrapper that owns the replacement port", async ({ env }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    await writeTaskCommand(env, '"C:\\bin\\openclaw-doppler.exe" gateway --port 18789');
    mockTerminatingProcess('"C:\\bin\\openclaw-doppler.exe" gateway --port 18789');

    inspectPortUsageMock
      .mockResolvedValueOnce(
        portUsage("busy", [
          processListener(
            4242,
            '"C:\\bin\\openclaw-doppler.exe" gateway --port 18789',
            "openclaw-doppler.exe",
          ),
        ]),
      )
      .mockImplementation(async (port) => portUsage("free", [], port));
    addSuccessfulMigrationResponses();

    await installGatewayScheduledTask(env);

    expectTaskkillPid(4242);
    await expect(fs.access(startupEntryPath)).rejects.toThrow();
  });

  it("refuses takeover when only PID existence can be verified", async ({ env }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
    spawnSync.mockImplementation((command, args) => {
      if (
        command === getWindowsPowerShellExePath() &&
        Array.isArray(args) &&
        args.includes(NODE_PROCESS_QUERY)
      ) {
        return makeSpawnSyncResult({ status: 1 });
      }
      if (command.endsWith("tasklist.exe")) {
        return makeSpawnSyncResult({
          stdout: '"node.exe","4242","Console","1","1,024 K"',
        });
      }
      return makeSpawnSyncResult();
    });

    await expect(installGatewayScheduledTask(env)).rejects.toThrow(
      "could not verify the installed process",
    );

    expect(spawnSync.mock.calls.some(([command]) => command.endsWith("taskkill.exe"))).toBe(false);
    await fs.access(startupEntryPath);
  });

  it("accepts a process-exit race without forcing a stale PID", async ({ env }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    mockTerminatingProcess(INSTALLED_GATEWAY_COMMAND, 4242, 128);

    addSuccessfulMigrationResponses();

    await installGatewayScheduledTask(env);

    const forcedCalls = spawnSync.mock.calls.filter(
      ([command, args]) =>
        command.endsWith("taskkill.exe") && Array.isArray(args) && args.includes("/F"),
    );
    expect(forcedCalls).toHaveLength(0);
    await expect(fs.access(startupEntryPath)).rejects.toThrow();
  });

  it("refuses migration when another gateway owns the fallback port", async ({ env, tmpDir }) => {
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

    await expect(installGatewayScheduledTask(env)).rejects.toThrow(
      "gateway listener on port 18789 does not match the persisted command",
    );

    expectNoGatewayTermination();
    await fs.access(startupEntryPath);
  });

  it("relaunches the verified fallback when Scheduled Task takeover fails", async ({ env }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    await writeRunningGatewayScript(env, 4242);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
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

    await expect(installGatewayScheduledTask(env)).rejects.toThrow(
      "schtasks run failed: restart denied",
    );

    expectGatewayTermination(4242);
    expectStartupFallbackSpawn();
    await fs.access(startupEntryPath);
  });

  it("probes the old fallback port before replacing a drifted task script", async ({ env }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    let oldPortProbed = false;
    await writeRunningGatewayScript(env, 4242, () => oldPortProbed);
    env.OPENCLAW_GATEWAY_PORT = "19433";
    inspectPortUsageMock.mockImplementation(async (port) => {
      oldPortProbed ||= port === 18789;
      return { port, status: "free", listeners: [], hints: [] };
    });
    addSuccessfulMigrationResponses();

    await installGatewayScheduledTask(env, new PassThrough(), "19433");

    expect(inspectPortUsageMock).toHaveBeenCalledWith(18789, {
      probeHosts: ["127.0.0.1"],
    });
    expectGatewayTermination(4242);
    await expect(fs.access(startupEntryPath)).rejects.toThrow();
  });

  it("does not take over when another process owns the replacement port", async ({ env }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    await writeGatewayScript(env, 18789);
    const scriptPath = resolveTaskScriptPath(env);
    const scriptBefore = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
    env.OPENCLAW_GATEWAY_PORT = "19433";
    mockProcesses(() => [
      processEntry(4242),
      processEntry(5252, OTHER_GATEWAY_COMMAND),
      POWERSHELL_PROCESS,
    ]);

    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [processListener(5252, OTHER_GATEWAY_COMMAND)], 19433),
    );
    addMissingTaskInstallResponses([
      ...successfulResponses(2),
      runningTaskSnapshot(),
      runningTaskSnapshot(),
    ]);
    const pendingSchtasksResponses = schtasksResponses.length;

    await expect(installGatewayScheduledTask(env, new PassThrough(), "19433")).rejects.toThrow(
      "replacement gateway port 19433 is occupied by an unverified process",
    );

    const oldPidKills = spawnSync.mock.calls.filter(
      ([command, args]) =>
        command.endsWith("taskkill.exe") &&
        Array.isArray(args) &&
        args.includes("/PID") &&
        args.includes("4242"),
    );
    expect(oldPidKills).toHaveLength(0);
    expect(schtasksResponses).toHaveLength(pendingSchtasksResponses);
    expect(decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) })).toBe(
      scriptBefore,
    );
    await fs.access(startupEntryPath);
  });

  it("preflights the replacement port when the fallback is stopped", async ({ env }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    await writeGatewayScript(env, 18789);
    const scriptPath = resolveTaskScriptPath(env);
    const scriptBefore = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
    env.OPENCLAW_GATEWAY_PORT = "19433";
    mockProcesses(() => [processEntry(5252, OTHER_GATEWAY_COMMAND), POWERSHELL_PROCESS]);
    inspectPortUsageMock.mockImplementation(async (port) =>
      port === 19433
        ? portUsage("busy", [processListener(5252, OTHER_GATEWAY_COMMAND)], port)
        : portUsage("free", [], port),
    );

    await expect(installGatewayScheduledTask(env, new PassThrough(), "19433")).rejects.toThrow(
      "replacement gateway port 19433 is occupied by an unverified process",
    );

    expect(decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) })).toBe(
      scriptBefore,
    );
    await fs.access(startupEntryPath);
  });

  it("refuses takeover when the replacement port probe is inconclusive", async ({ env }) => {
    const startupEntryPath = await writeStartupFallbackEntry(env);
    await writeGatewayScript(env, 18789);
    const scriptPath = resolveTaskScriptPath(env);
    const scriptBefore = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
    env.OPENCLAW_GATEWAY_PORT = "19433";
    mockProcesses(() => [processEntry(4242), POWERSHELL_PROCESS]);
    inspectPortUsageMock.mockResolvedValue(portUsage("unknown", [], 19433));

    await expect(installGatewayScheduledTask(env, new PassThrough(), "19433")).rejects.toThrow(
      "Could not verify replacement gateway port 19433",
    );

    expect(decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) })).toBe(
      scriptBefore,
    );
    await fs.access(startupEntryPath);
  });

  it("does not relaunch a fallback after an accepted takeover task has no launch evidence", async ({
    env,
  }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    mockTerminatingProcess();

    inspectPortUsageMock
      .mockResolvedValueOnce(portUsage("busy", [{ pid: 4242, command: "node.exe" }]))
      .mockResolvedValue(portUsage("free"));
    fastForwardTaskStartWait();
    addMissingTaskInstallResponses([...successfulResponses(2), runningTaskSnapshot()]);
    queueNativeResponses(
      ...successfulResponses(2),
      notYetRunTaskSnapshot(),
      notYetRunTaskSnapshot(),
    );

    await expect(installGatewayScheduledTask(env)).rejects.toThrow("refusing a direct fallback");

    expect(spawn).not.toHaveBeenCalled();
    await fs.access(startupEntryPath);
  });

  it("does not relaunch a fallback when an accepted replacement task never becomes observable", async ({
    env,
  }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    let processQueries = 0;
    mockProcesses(() => [
      ...(++processQueries < 3 ? [processEntry(4242)] : []),
      POWERSHELL_PROCESS,
    ]);

    fastForwardTaskStartWait();
    addStartupFallbackMissingResponses([...successfulResponses(2), runningTaskSnapshot()]);
    addSuccessfulScheduledTaskRestartResponses([notYetRunTaskSnapshot()], {
      ...notYetRunTaskSnapshot(),
      state: 2,
    });

    await expect(installGatewayScheduledTask(env)).rejects.toThrow(
      "Replacement Windows Scheduled Task did not produce running evidence",
    );

    expect(spawn).not.toHaveBeenCalled();
    await fs.access(startupEntryPath);
  });

  it("re-probes the captured fallback port after a transient config reload", async ({ env }) => {
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

    await installGatewayScheduledTask(env, new PassThrough(), "19433", {
      status: "running",
      pid: 4242,
    });

    expect(oldPortProbes).toBeGreaterThanOrEqual(3);
    expectGatewayTermination(4242);
    await expect(fs.access(startupEntryPath)).rejects.toThrow();
  });

  it("keeps the fallback when a previously running process cannot be proven gone", async ({
    env,
  }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    inspectPortUsageMock.mockResolvedValue(portUsage("free"));

    await expect(
      installGatewayScheduledTask(env, new PassThrough(), "18789", { status: "running" }),
    ).rejects.toThrow("previously running Windows login item has not exited cleanly");
    await fs.access(startupEntryPath);
  });

  it("preserves Startup definition bytes and modes when requested", async ({ env }) => {
    const files = [
      await writeStartupFallbackEntry(env),
      await writeStartupFallbackEntry(env, "vbs"),
    ];
    const snapshot = () =>
      Promise.all(
        files.map(async (file) => ({
          bytes: await fs.readFile(file),
          mode: (await fs.stat(file)).mode,
        })),
      );
    const before = await snapshot();
    await writeGatewayScript(env);
    queueNativeResponses(cleanExitTaskSnapshot(), cleanExitTaskSnapshot());
    addSuccessfulScheduledTaskRestartResponses([notYetRunTaskSnapshot(), runningTaskSnapshot()]);

    await restartScheduledTask({ env, stdout: new PassThrough(), preserveDefinition: true });

    expect(await snapshot()).toEqual(before);
    expect(sleepMock).not.toHaveBeenCalled();
    expect(taskProbe).toHaveBeenCalledTimes(3);
  });

  it("does not mistake a hidden launcher exit for Scheduled Task supervision", async ({ env }) => {
    const hiddenEnv = { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" };
    const startupEntryPath = await writeStartupFallbackEntry(hiddenEnv);
    await writeGatewayScript(hiddenEnv);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
    inspectPortUsageMock.mockImplementation(async () =>
      schtasksCalls.some((call) => call[0] === "/Run")
        ? portUsage("busy", [processListener(4242, INSTALLED_GATEWAY_COMMAND)])
        : portUsage("free"),
    );
    queueNativeResponses(cleanExitTaskSnapshot(), cleanExitTaskSnapshot());
    addSuccessfulScheduledTaskRestartResponses([cleanExitTaskSnapshot()], cleanExitTaskSnapshot());

    await restartScheduledTask({ env: hiddenEnv, stdout: new PassThrough() });

    await fs.access(startupEntryPath);
  });

  it("does not start a competing fallback after uncertain Scheduled Task registration", async ({
    env,
  }) => {
    addMissingTaskInstallResponses([
      { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
    ]);

    await expect(installGatewayScheduledTask(env)).rejects.toThrow(
      "Scheduled Task registration did not confirm completion",
    );

    await expect(fs.access(resolveStartupFixturePath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not publish a launcher when Scheduled Task presence cannot be verified", async ({
    env,
  }) => {
    queueNativeResponses({
      code: 124,
      stdout: "",
      stderr: "schtasks produced no output for 30000ms",
    });

    await expect(installGatewayScheduledTask(env)).rejects.toThrow(
      "Could not back up Scheduled Task OpenClaw Gateway before replacement",
    );

    await expect(fs.access(resolveTaskScriptPath(env))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(resolveStartupFixturePath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
  });

  it("does not fall back when a listener appears after the clean task exit", async ({ env }) => {
    spawnSync.mockImplementation((command, args) =>
      command === getWindowsPowerShellExePath() && args?.includes(NODE_PROCESS_QUERY)
        ? makeSpawnSyncResult({ status: 1 })
        : makeSpawnSyncResult(),
    );
    fastForwardTaskStartWait();
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
    let portInspections = 0;
    inspectPortUsageMock.mockImplementation(async (port) =>
      portInspections++ === 0
        ? portUsage("free", [], port)
        : portUsage("busy", [processListener(4242, "node gateway.js --port 18789")], port),
    );
    addMissingTaskInstallResponses([
      ...successfulResponses(2),
      cleanExitTaskSnapshot(),
      cleanExitTaskSnapshot(),
    ]);

    await installGatewayScheduledTask(env);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not treat a gateway listener as node Scheduled Task launch evidence", async ({
    env,
  }) => {
    fastForwardTaskStartWait();
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
    addAcceptedRunNeverStartsResponses();

    await installNodeScheduledTask(env);

    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
    expectStartupFallbackSpawn();
  });

  it("does not relaunch the task script when the scheduled task process is already starting", async ({
    env,
  }) => {
    const taskScriptPath = resolveTaskScriptPath(env);
    fastForwardTaskStartWait();
    mockProcesses(() => [processEntry(4242, `cmd.exe /d /s /c "${taskScriptPath}"`)]);

    addAcceptedRunNeverStartsResponses();

    await installGatewayScheduledTask(env);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not attribute another gateway listener to the registered task", async ({ env }) => {
    await writeGatewayScript(env);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [
        processListener(
          4242,
          '"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\dist\\index.js" gateway --port 18789',
        ),
      ]),
    );
    mockProcesses(() => [
      processEntry(
        4242,
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\dist\\index.js" gateway --port 18789',
      ),
    ]);
    queueNativeResponses(notYetRunTaskSnapshot());

    const runtime = await readScheduledTaskRuntime(env);
    expect(runtime.status).toBe("stopped");
    expect(runtime.pid).toBeUndefined();
    expect(runtime.state).toBe("Ready");
    expect(runtime.lastRunResult).toBe("267011");
  });

  it.each([
    { state: 3, expected: "running" },
    { state: 2, expected: "unknown" },
  ])(
    "retains the exact gateway PID without hiding task state $state",
    async ({ state, expected }) => {
      await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
        await writeGatewayScript(env);
        queueNativeResponses({ ...notYetRunTaskSnapshot(), state });
        mockProcesses(() => [processEntry(4242)]);

        const runtime = await readScheduledTaskRuntime(env);
        expect(runtime.status).toBe(expected);
        expect(runtime.pid).toBe(4242);
        expect(runtime.detail).toContain("Gateway process detected");
        expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
        expect(inspectPortUsageMock).not.toHaveBeenCalled();
      });
    },
  );

  it("does not report a node task as running from a gateway listener", async ({ env }) => {
    env.OPENCLAW_SERVICE_KIND = "node";
    env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
    queueNativeResponses(notYetRunTaskSnapshot());

    const runtime = await readScheduledTaskRuntime(env);
    expect(runtime.status).toBe("stopped");
    expect(runtime.state).toBe("Ready");
    expect(runtime.lastRunResult).toBe("267011");
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("reports a registered node task as running from the matching node host process", async ({
    env,
  }) => {
    const nodeEnv = {
      ...env,
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
    };
    await writeNodeScript(nodeEnv);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
    queueNativeResponses(notYetRunTaskSnapshot());
    mockProcesses(() => [
      processEntry(4242, "C:\\manual\\openclaw.cmd node run --host 127.0.0.1 --port 18789"),
      processEntry(5151, NODE_HOST_COMMAND),
    ]);

    const runtime = await readScheduledTaskRuntime(nodeEnv);
    expect(runtime.status).toBe("running");
    expect(runtime.pid).toBe(5151);
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
    expect(inspectPortUsageMock).not.toHaveBeenCalled();
  });

  it("finds a legacy Startup cmd entry despite hidden launcher opt-in until removed", async ({
    env,
  }) => {
    const taskEnv = { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" };
    taskProbe.mockReturnValue({ status: 1, stdout: "-2147024894" });
    const startupEntryPath = await writeStartupFallbackEntry(env);

    await expect(isScheduledTaskInstalled({ env: taskEnv })).resolves.toBe(true);
    await fs.unlink(startupEntryPath);
    await expect(isScheduledTaskInstalled({ env: taskEnv })).resolves.toBe(false);
  });

  it("uninstalls both Startup launcher formats after hidden launcher opt-in", async ({ env }) => {
    queueNativeResponses({ code: 0, stdout: "", stderr: "" });
    const entries = [
      await writeStartupFallbackEntry(env),
      await writeStartupFallbackEntry(env, "vbs"),
    ];

    await uninstallScheduledTask({
      env: { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" },
      stdout: new PassThrough(),
    });

    for (const entry of entries) {
      await expect(fs.access(entry)).rejects.toThrow();
    }
  });

  it("reports runtime from a verified gateway listener when using the Startup fallback", async ({
    env,
    tmpDir,
  }) => {
    taskProbe.mockReturnValue({ status: 1, stdout: "-2147024894" });
    await writeStartupFallbackEntry(env);
    const commandLine = await writeGatewayPackageCommand(path.join(tmpDir, "listener-install"));
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [{ pid: 4242, command: "node.exe", commandLine }]),
    );

    const runtime = await readScheduledTaskRuntime(env);
    expect(runtime.status).toBe("running");
    expect(runtime.pid).toBe(4242);
  });

  it("does not kill the gateway listener when stopping a node Startup fallback", async ({
    env,
  }) => {
    const nodeEnv = makeNodeServiceEnv(env);
    addStartupFallbackMissingResponses();
    await writeStartupFallbackEntry(nodeEnv);
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [
        processListener(5151, 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789'),
      ]),
    );

    spawnSync.mockReturnValueOnce(
      makeSpawnSyncResult({
        stdout: JSON.stringify([
          {
            ProcessId: 5151,
            CommandLine: 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789',
          },
        ]),
      }),
    );

    await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

    expect(inspectPortUsageMock).not.toHaveBeenCalled();
    expectNoGatewayTermination();
  });

  it("stops a node Startup fallback by terminating the matching node host process", async ({
    env,
  }) => {
    const nodeEnv = makeNodeServiceEnv(env);
    addStartupFallbackMissingResponses();
    await writeStartupFallbackEntry(nodeEnv);
    await writeNodeScript(nodeEnv);
    mockTerminatingProcess(NODE_HOST_COMMAND, 5151);

    await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

    expect(inspectPortUsageMock).not.toHaveBeenCalled();
    expectTaskkillPid(5151);
  });

  it("cleans up a stale node Startup fallback when a node Scheduled Task is registered", async ({
    env,
  }) => {
    const nodeEnv = makeNodeServiceEnv(env);
    queueNativeResponses(...successfulResponses(3));
    await writeStartupFallbackEntry(nodeEnv);
    await writeNodeScript(nodeEnv);
    mockTerminatingProcess(NODE_HOST_COMMAND, 5151);

    await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

    expect(inspectPortUsageMock).not.toHaveBeenCalled();
    expectTaskkillPid(5151);
  });

  it("restarts the Startup fallback by killing the current pid and relaunching the entry", async ({
    env,
  }) => {
    addStartupFallbackMissingResponses([
      { code: 0, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "not found" },
    ]);
    await writeRunningGatewayScript(env, 5151);
    await writeStartupFallbackEntry(env);
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [
        processListener(5151, 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789'),
      ]),
    );

    const stdout = new PassThrough();
    await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
      outcome: "completed",
    });
    expectGatewayTermination(5151);
    expectStartupFallbackSpawn();
  });

  it.each(["termination", "activation"] as const)(
    "refuses Startup fallback restart after losing continuation authority before %s",
    async (stage) => {
      await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
        addStartupFallbackMissingResponses();
        await writeStartupFallbackEntry(env);
        let current = true;
        await writeRunningGatewayScript(env, 5151, () => {
          current = false;
          return stage === "termination";
        });

        await expect(
          restartScheduledTask({
            env,
            stdout: new PassThrough(),
            assertCurrent: () => {
              if (!current) {
                throw new Error("repair continuation retired");
              }
            },
          }),
        ).rejects.toThrow("repair continuation retired");

        expectNoGatewayTermination();
        expect(spawn).not.toHaveBeenCalled();
      });
    },
  );

  it("audits Startup fallback termination when relaunch fails", async ({ env }) => {
    addStartupFallbackMissingResponses([
      { code: 0, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "not found" },
    ]);
    await writeRunningGatewayScript(env, 5151);
    await writeStartupFallbackEntry(env);
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [
        processListener(5151, 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789'),
      ]),
    );
    spawn.mockImplementationOnce(() => createSpawnChild(childUnref, new Error("spawn failed")));
    const onMutation = vi.fn();

    await expect(
      restartScheduledTask({ env, stdout: new PassThrough(), onMutation }),
    ).rejects.toThrow("spawn failed");

    expectGatewayTermination(5151);
    expect(onMutation).toHaveBeenCalledWith({ mode: "startup-entry-stop" });
    expect(onMutation).not.toHaveBeenCalledWith({ mode: "startup-entry-restart" });
  });

  it("refuses to restart a Startup fallback with an unverified busy port owner", async ({
    env,
  }) => {
    await writeGatewayScript(env);
    addStartupFallbackMissingResponses();
    await writeStartupFallbackEntry(env);
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [{ pid: 5151, command: "other.exe" }]),
    );

    await expect(restartScheduledTask({ env, stdout: new PassThrough() })).rejects.toThrow(
      "not a verified gateway process",
    );
    expectNoGatewayTermination();
    expect(spawn).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
