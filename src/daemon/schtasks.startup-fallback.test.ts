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
  createSchtasksNativeFixture,
  notYetRunTaskSnapshot,
  cleanExitTaskSnapshot,
  runningTaskSnapshot,
  inspectPortUsageMock,
  isProcessSnapshotQuery,
  killProcessTreeMock,
  makeSpawnSyncResult,
  resetSchtasksBaseMocks,
  resolveStartupFixturePath,
  schtasksCalls,
  schtasksResponses,
  schtasksRegistration,
  withWindowsEnv as withBaseWindowsEnv,
  writeGatewayScript,
  writeNodeScript as writeBaseNodeScript,
  writeStartupFallbackEntry,
  type SpawnSyncResult,
  type TaskProbeResult,
  type TaskSnapshot,
  type NativeResponse,
} from "./test-helpers/schtasks-fixtures.js";

type WindowsFixture = Parameters<Parameters<typeof withBaseWindowsEnv>[1]>[0];
let fixtureEnv: Record<string, string>;
async function writeNodeScript(env: Record<string, string>) {
  fixtureEnv = env;
  return writeBaseNodeScript(env);
}
const it = baseIt.extend<WindowsFixture & { windows: WindowsFixture }>({
  windows: async ({ task }, use) => {
    await withBaseWindowsEnv(`openclaw-win-startup-${task.id}-`, async (fixture) => {
      fixtureEnv = fixture.env;
      await use(fixture);
    });
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
  vi.fn<
    (command: string, args?: readonly string[], options?: SpawnSyncOptions) => SpawnSyncResult
  >(),
);
const taskProbe = vi.hoisted(() =>
  vi.fn<
    (command: string, args?: readonly string[], options?: SpawnSyncOptions) => TaskProbeResult
  >(),
);

const nativeTask = createSchtasksNativeFixture(() => fixtureEnv);
const { queue: queueNativeResponses, advance: advanceTaskProbe } = nativeTask;

const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep: sleepMock,
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
  findVerifiedGatewayListenerPidsOnPortSync,
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

const STARTUP_GATEWAY_COMMAND =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789';
const STARTUP_NODE_COMMAND = 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789';

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
    if (command === getWindowsPowerShellExePath() && isProcessSnapshotQuery(args)) {
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
    if (command === getWindowsPowerShellExePath() && isProcessSnapshotQuery(args)) {
      return makeSpawnSyncResult({
        stdout: JSON.stringify([
          ...(!terminated && isRunning()
            ? [{ ProcessId: processId, CommandLine: STARTUP_GATEWAY_COMMAND + processSuffix }]
            : []),
          POWERSHELL_PROCESS,
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

function mockBusyPort(pid: number, commandLine = INSTALLED_GATEWAY_COMMAND) {
  inspectPortUsageMock.mockResolvedValue(portUsage("busy", [processListener(pid, commandLine)]));
}

const readLauncher = async (scriptPath: string) =>
  decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
const nativeFailure = (stderr: string, code = 1) => ({ code, stdout: "", stderr });
const taskkillCalls = () =>
  spawnSync.mock.calls.filter(([command]) => command.endsWith("taskkill.exe"));

function portUsage(
  status: PortUsage["status"],
  listeners: PortUsage["listeners"] = [],
  port = 18789,
): PortUsage {
  return { port, status, listeners, hints: [] };
}

function expectTaskkillPid(pid: number): void {
  expect(
    taskkillCalls().some(([, args]) => args?.includes("/PID") && args.includes(String(pid))),
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
  expect(taskkillCalls()).toEqual([]);
}

const restartFallback = (
  env: Record<string, string>,
  options: Partial<Parameters<typeof restartScheduledTask>[0]> = {},
) => restartScheduledTask({ env, stdout: new PassThrough(), ...options });

async function expectMissing(file: string) {
  await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function prepareFallbackRestart(env: Record<string, string>) {
  addStartupFallbackMissingResponses([...successfulResponses(1), nativeFailure("not found")]);
  await writeRunningGatewayScript(env, 5151);
  await writeStartupFallbackEntry(env);
  mockBusyPort(5151, STARTUP_NODE_COMMAND);
}

function successfulResponses(count: number): (typeof schtasksResponses)[number][] {
  return Array.from({ length: count }, () => ({ code: 0, stdout: "", stderr: "" }));
}

function addMissingTaskInstallResponses(responses: NativeResponse[]): void {
  schtasksRegistration.response = nativeFailure(
    "ERROR: The system cannot find the file specified.",
  );
  queueNativeResponses(...responses);
}

function addStartupFallbackMissingResponses(extraResponses: NativeResponse[] = []) {
  addMissingTaskInstallResponses([
    ...successfulResponses(1),
    nativeFailure("ERROR: The system cannot find the file specified."),
    ...extraResponses,
  ]);
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
  fixtureEnv = makeNodeServiceEnv(env);
  return installScheduledTask({
    env: fixtureEnv,
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
    advanceTaskProbe();
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

function addTakeoverResponses(...responses: NativeResponse[]) {
  addMissingTaskInstallResponses([...successfulResponses(2), runningTaskSnapshot(), ...responses]);
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  nativeTask.reset();
  taskProbe.mockReset().mockImplementation(nativeTask.probe);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
  inspectPortUsageMock.mockResolvedValue(portUsage("free"));
  spawn.mockReset();
  spawn.mockImplementation(() => createSpawnChild(childUnref));
  spawnSync.mockReset();
  mockProcesses(() => [POWERSHELL_PROCESS]);
  childUnref.mockClear();
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
    advanceTaskProbe();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Windows startup fallback", () => {
  it("uses the locale-independent task probe when a scheduled task is missing", async ({ env }) => {
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
        detail: "Scheduled Task check failed (exit 1): -2147024891",
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
    addMissingTaskInstallResponses([nativeFailure("ERROR: Access is denied.", 5)]);
    await expect(
      withGatewayServiceUpdateAuthority(
        () => {},
        () => installGatewayScheduledTask(env),
      ),
    ).rejects.toThrow("startup fallback is unsupported");
    await expectMissing(resolveStartupFixturePath(env));
    expect(spawn).not.toHaveBeenCalled();
  });

  it.for(["cmd", "vbs"] as const)(
    "installs the %s Startup launcher after a localized create denial",
    async (extension, { env }) => {
      const hidden = extension === "vbs";
      addMissingTaskInstallResponses([
        nativeFailure(hidden ? "ERROR: Access is denied." : "错误: 拒绝访问。", hidden ? 5 : 1),
      ]);
      const stdout = new PassThrough();
      const result = await installGatewayScheduledTask(
        hidden ? { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" } : env,
        stdout,
      );
      const raw = await fs.readFile(resolveStartupFixturePath(env, extension));
      const script = decodeWindowsLauncherScript({ buffer: raw });
      expect(result.scriptPath).toBe(resolveTaskScriptPath(env));
      expect(script).toContain("gateway.cmd");
      if (hidden) {
        // Wscript requires BOM-prefixed UTF-16 to preserve CJK paths.
        expect(raw.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
        expect(script).toContain("WScript.Shell");
        expect(script).toContain(`WScript.Quit shell.Run("""${result.scriptPath}""", 0, True)`);
      } else {
        expect(script).toContain(`start "" /min ${getWindowsCmdExePath()} /d /c`);
        expect(childUnref).toHaveBeenCalled();
        expect(String(stdout.read())).toContain("Installed Windows login item");
      }
      expectStartupFallbackSpawn();
    },
  );

  it("removes an old Startup-folder launcher after migrating to a Scheduled Task", async ({
    env,
  }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    const hiddenStartupEntryPath = await writeStartupFallbackEntry(env, "vbs");
    addSuccessfulMigrationResponses();

    const stdout = new PassThrough();
    await installGatewayScheduledTask(env, stdout);

    await expectMissing(startupEntryPath);
    await expectMissing(hiddenStartupEntryPath);
    const printed = String(stdout.read(stdout.readableLength));
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
    addTakeoverResponses(...successfulResponses(2));
    const progress = notYetRunTaskSnapshot("2026-04-15T23:42:31.0000000Z");
    queueNativeResponses(notYetRunTaskSnapshot(), progress, runningTaskSnapshot());
    const stdout = new PassThrough();

    await expect(installGatewayScheduledTask(env, stdout)).resolves.toEqual({
      scriptPath: resolveTaskScriptPath(env),
    });

    expectGatewayTermination(4242);
    expect(spawn).not.toHaveBeenCalled();
    expect(schtasksResponses).toEqual([]);
    expect(sleepMock.mock.calls).toEqual([[250], [250]]);
    const printed = String(stdout.read(stdout.readableLength));
    expect(printed).toContain("Restarted Scheduled Task");
    expect(printed).not.toContain("Removed Windows login item");
    await expectMissing(startupEntryPath);
  });

  it("refuses takeover when only PID existence can be verified", async ({ env }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
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

    await expect(installGatewayScheduledTask(env)).rejects.toThrow(
      "could not verify the installed process",
    );

    expect(taskkillCalls()).toHaveLength(0);
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
    await expectMissing(startupEntryPath);
  });

  it("refuses migration when another gateway owns the fallback port", async ({ env, tmpDir }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    const commandLine = await writeGatewayPackageCommand(path.join(tmpDir, "other-install"));
    mockProcesses(() => [
      processEntry(3131, "C:\\manual\\openclaw.cmd gateway --port 18789"),
      processEntry(4242, commandLine),
      POWERSHELL_PROCESS,
    ]);

    mockBusyPort(4242, commandLine);

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
    addTakeoverResponses(...successfulResponses(1), nativeFailure("restart denied"));

    await expect(installGatewayScheduledTask(env)).rejects.toThrow(
      "schtasks run failed: restart denied",
    );

    expectGatewayTermination(4242);
    expectStartupFallbackSpawn();
    await fs.access(startupEntryPath);
  });

  it.for([
    {
      status: "busy",
      error: "replacement gateway port 19433 is occupied by an unverified process",
    },
    { status: "unknown", error: "Could not verify replacement gateway port 19433" },
  ] as const)(
    "preserves the fallback when the replacement port is $status",
    async ({ status, error }, { env }) => {
      const startupEntryPath = await writeGatewayFallback(env);
      const scriptPath = resolveTaskScriptPath(env);
      const scriptBefore = await readLauncher(scriptPath);
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
      await expect(installGatewayScheduledTask(env, new PassThrough(), "19433")).rejects.toThrow(
        error,
      );
      expect(await readLauncher(scriptPath)).toBe(scriptBefore);
      await fs.access(startupEntryPath);
    },
  );

  it.for([
    { state: "not-yet-run", error: "refusing a direct fallback" },
    {
      state: "unobservable",
      error: "Replacement Windows Scheduled Task did not produce running evidence",
    },
  ])("never relaunches an accepted $state replacement", async ({ state, error }, { env }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    if (state === "not-yet-run") {
      mockTerminatingProcess();
      inspectPortUsageMock
        .mockResolvedValueOnce(portUsage("busy", [{ pid: 4242, command: "node.exe" }]))
        .mockResolvedValue(portUsage("free"));
    } else {
      let queries = 0;
      mockProcesses(() => [...(++queries < 3 ? [processEntry(4242)] : []), POWERSHELL_PROCESS]);
    }
    fastForwardTaskStartWait();
    addTakeoverResponses();
    if (state === "not-yet-run") {
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
    await expect(installGatewayScheduledTask(env)).rejects.toThrow(error);
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
        : portUsage("busy", [processListener(4242, STARTUP_NODE_COMMAND)], port);
    });
    addSuccessfulMigrationResponses();

    await installGatewayScheduledTask(env, new PassThrough(), "19433", {
      status: "running",
      pid: 4242,
    });

    expect(oldPortProbes).toBeGreaterThanOrEqual(3);
    expectGatewayTermination(4242);
    await expectMissing(startupEntryPath);
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

    await restartFallback(env, { preserveDefinition: true });

    expect(await snapshot()).toEqual(before);
    expect(sleepMock).not.toHaveBeenCalled();
    expect(schtasksCalls.filter(([action]) => action === "/Run")).toHaveLength(1);
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
    mockProcesses(() =>
      schtasksCalls.some(([action]) => action === "/Run") ? [processEntry(4242)] : [],
    );
    queueNativeResponses(cleanExitTaskSnapshot(), cleanExitTaskSnapshot());
    addSuccessfulScheduledTaskRestartResponses([cleanExitTaskSnapshot()], cleanExitTaskSnapshot());

    await restartFallback(hiddenEnv);

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

    await expectMissing(resolveStartupFixturePath(env));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not publish a launcher when Scheduled Task presence cannot be verified", async ({
    env,
  }) => {
    schtasksRegistration.response = {
      code: 124,
      stdout: "",
      stderr: "schtasks produced no output for 30000ms",
    };
    taskProbe.mockReturnValue({ status: 2, stdout: "-2147024891" });

    await expect(installGatewayScheduledTask(env)).rejects.toThrow(
      "Could not back up Scheduled Task OpenClaw Gateway before replacement",
    );

    await expectMissing(resolveTaskScriptPath(env));
    await expectMissing(resolveStartupFixturePath(env));
    expect(spawn).not.toHaveBeenCalled();
    expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
  });

  it("does not fall back when a listener appears after the clean task exit", async ({ env }) => {
    spawnSync.mockImplementation((command, args) =>
      command === getWindowsPowerShellExePath() && isProcessSnapshotQuery(args)
        ? makeSpawnSyncResult({ status: 1 })
        : makeSpawnSyncResult(),
    );
    fastForwardTaskStartWait();
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
    inspectPortUsageMock.mockImplementation(async (port) =>
      timeState.now === 0
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
      await expectMissing(entry);
    }
  });

  it("reports runtime from a verified gateway listener when using the Startup fallback", async ({
    env,
    tmpDir,
  }) => {
    taskProbe.mockReturnValue({ status: 1, stdout: "-2147024894" });
    await writeStartupFallbackEntry(env);
    const commandLine = await writeGatewayPackageCommand(path.join(tmpDir, "listener-install"));
    mockBusyPort(4242, commandLine);

    expect(await readScheduledTaskRuntime(env)).toMatchObject({ status: "running", pid: 4242 });
  });

  it("does not kill the gateway listener when stopping a node Startup fallback", async ({
    env,
  }) => {
    const nodeEnv = makeNodeServiceEnv(env);
    addStartupFallbackMissingResponses();
    await writeStartupFallbackEntry(nodeEnv);
    mockBusyPort(5151, STARTUP_NODE_COMMAND);
    spawnSync.mockReturnValueOnce(
      makeSpawnSyncResult({
        stdout: JSON.stringify([processEntry(5151, STARTUP_NODE_COMMAND)]),
      }),
    );

    await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

    expect(inspectPortUsageMock).not.toHaveBeenCalled();
    expectNoGatewayTermination();
  });

  it.for([false, true])(
    "stops the node Startup host (registered task=%s)",
    async (registered, { env }) => {
      const nodeEnv = makeNodeServiceEnv(env);
      if (registered) {
        queueNativeResponses(...successfulResponses(3));
      } else {
        addStartupFallbackMissingResponses();
      }
      await writeStartupFallbackEntry(nodeEnv);
      await writeNodeScript(nodeEnv);
      mockTerminatingProcess(NODE_HOST_COMMAND, 5151);

      await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

      expect(inspectPortUsageMock).not.toHaveBeenCalled();
      expectTaskkillPid(5151);
    },
  );

  it.for([false, true])(
    "terminates the Startup child and audits a relaunch (spawn failure=%s)",
    async (fails, { env }) => {
      await prepareFallbackRestart(env);
      const onMutation = vi.fn();
      if (fails) {
        spawn.mockImplementationOnce(() => createSpawnChild(childUnref, new Error("spawn failed")));
      }
      const restart = restartFallback(env, { onMutation });
      if (fails) {
        await expect(restart).rejects.toThrow("spawn failed");
        expect(childUnref).not.toHaveBeenCalled();
        expect(onMutation).toHaveBeenCalledWith({ mode: "startup-entry-stop" });
        expect(onMutation).not.toHaveBeenCalledWith({ mode: "startup-entry-restart" });
      } else {
        await expect(restart).resolves.toEqual({ outcome: "completed" });
        expectStartupFallbackSpawn();
      }
      expectGatewayTermination(5151);
    },
  );

  it.for(["termination", "activation"] as const)(
    "refuses Startup fallback restart after losing continuation authority before %s",
    async (stage, { env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);
      let current = true;
      await writeRunningGatewayScript(env, 5151, () => {
        current = false;
        return stage === "termination";
      });

      await expect(
        restartFallback(env, {
          assertCurrent: () => {
            if (!current) {
              throw new Error("repair continuation retired");
            }
          },
        }),
      ).rejects.toThrow("repair continuation retired");

      expectNoGatewayTermination();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("refuses to restart a Startup fallback with an unverified busy port owner", async ({
    env,
  }) => {
    addStartupFallbackMissingResponses();
    await writeGatewayFallback(env);
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [{ pid: 5151, command: "other.exe" }]),
    );

    await expect(restartFallback(env)).rejects.toThrow("not a verified gateway process");
    expectNoGatewayTermination();
    expect(spawn).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
