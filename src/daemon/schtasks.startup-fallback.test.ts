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
import "./test-helpers/schtasks-base-mocks.js";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
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

const verifiedGatewayPids = vi.hoisted(() => vi.fn<(port: number) => number[]>(() => []));

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
// mock-isolation: Windows fallback cases must not inspect or signal live gateway processes.
vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) => verifiedGatewayPids(port),
}));

const { restartScheduledTask, stopScheduledTask } = await import("./schtasks-control.js");
const { installScheduledTask, uninstallScheduledTask } = await import("./schtasks-install.js");
const { resolveTaskScriptPath } = await import("./schtasks-layout.js");
const { readScheduledTaskRuntime, removeStartupEntries } = await import("./schtasks-runtime.js");

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

function processSnapshot(entries: ReturnType<typeof processEntry>[]) {
  return makeSpawnSyncResult({ stdout: JSON.stringify(entries) });
}

function mockProcesses(
  read: () => ReturnType<typeof processEntry>[],
  onTaskkill?: () => SpawnSyncResult,
): void {
  spawnSync.mockImplementation((command, args) => {
    if (command === getWindowsPowerShellExePath() && isProcessSnapshotQuery(args)) {
      return processSnapshot(read());
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
      return processSnapshot([
        ...(!terminated && isRunning()
          ? [{ ProcessId: processId, CommandLine: STARTUP_GATEWAY_COMMAND + processSuffix }]
          : []),
        POWERSHELL_PROCESS,
      ]);
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

const readScript = async (file: string) =>
  decodeWindowsLauncherScript({ buffer: await fs.readFile(file) });
const expectMissing = (file: string) =>
  expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
const printedOutput = (stdout: PassThrough) => String(stdout.read(stdout.readableLength));

function portUsage(
  status: PortUsage["status"],
  listeners: PortUsage["listeners"] = [],
  port = 18789,
): PortUsage {
  return { port, status, listeners, hints: [] };
}

function expectTaskkillPid(pid: number): void {
  expect(spawnSync).toHaveBeenCalledWith(
    expect.stringMatching(/taskkill\.exe$/u),
    expect.arrayContaining(["/PID", String(pid)]),
    expect.anything(),
  );
}

function expectStartupFallbackSpawn() {
  expect(spawn).toHaveBeenLastCalledWith(
    expect.not.stringMatching(/^cmd\.exe$/u),
    expect.arrayContaining(["--port", "18789"]),
    expect.objectContaining({ env: expect.objectContaining({ OPENCLAW_GATEWAY_PORT: "18789" }) }),
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
  schtasksRegistration.response = {
    code: 1,
    stdout: "",
    stderr: "ERROR: The system cannot find the file specified.",
  };
  queueNativeResponses(...responses);
}

function addStartupFallbackMissingResponses(extraResponses: NativeResponse[] = []) {
  addMissingTaskInstallResponses([
    { code: 0, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." },
    ...extraResponses,
  ]);
}

function installGateway(
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

async function prepareFallbackRestart(env: Record<string, string>) {
  addStartupFallbackMissingResponses([
    ...successfulResponses(1),
    { code: 1, stdout: "", stderr: "not found" },
  ]);
  await writeRunningGatewayScript(env, 5151);
  await writeStartupFallbackEntry(env);
  inspectPortUsageMock.mockResolvedValue(
    portUsage("busy", [
      processListener(5151, 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789'),
    ]),
  );
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  nativeTask.reset();
  taskProbe.mockReset().mockImplementation(nativeTask.probe);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  verifiedGatewayPids.mockReset();
  verifiedGatewayPids.mockReturnValue([]);
  inspectPortUsageMock.mockResolvedValue(portUsage("free"));
  spawn.mockReset();
  spawn.mockImplementation(() => createSpawnChild(childUnref));
  spawnSync.mockReset();
  mockProcesses(() => [POWERSHELL_PROCESS]);
  childUnref.mockClear();
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  vi.spyOn(performance, "now").mockImplementation(() => timeState.now);
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
      const stdout = new PassThrough();
      const result = await installGateway(
        hidden ? { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" } : env,
        stdout,
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
      expect(printedOutput(stdout)).toContain("Installed Windows login item");
    },
  );

  it("removes both Startup formats after migration", async ({ env }) => {
    const startupEntryPath = await writeGatewayFallback(env);
    const hiddenStartupEntryPath = await writeStartupFallbackEntry(env, "vbs");
    addSuccessfulMigrationResponses();

    const stdout = new PassThrough();
    await installGateway(env, stdout);

    await expectMissing(startupEntryPath);
    await expectMissing(hiddenStartupEntryPath);
    const printed = printedOutput(stdout);
    expect(printed).toContain("Installed Scheduled Task");
    expect(printed).toContain("Removed Windows login item");
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
    const stdout = new PassThrough();

    await expect(installGateway(env, stdout)).resolves.toEqual({
      scriptPath: resolveTaskScriptPath(env),
    });

    expectGatewayTermination(4242);
    expect(spawn).not.toHaveBeenCalled();
    expect(schtasksResponses).toEqual([]);
    expect(sleepMock.mock.calls).toEqual([[250], [250]]);
    const printed = printedOutput(stdout);
    expect(printed).toContain("Restarted Scheduled Task");
    expect(printed).not.toContain("Removed Windows login item");
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
      await expect(installGateway(env)).rejects.toThrow(
        failure === "not launched"
          ? "refusing a direct fallback"
          : "Replacement Windows Scheduled Task did not produce running evidence",
      );
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
    expect(schtasksCalls.filter(([action]) => action === "/Run")).toHaveLength(1);
  });

  it("does not mistake launcher exit for task supervision", async ({ env }) => {
    const hiddenEnv = { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" };
    const startupEntryPath = await writeStartupFallbackEntry(hiddenEnv);
    await writeGatewayScript(hiddenEnv);
    verifiedGatewayPids.mockReturnValue([4242]);
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

    await restartScheduledTask({ env: hiddenEnv, stdout: new PassThrough() });

    await fs.access(startupEntryPath);
  });

  it("rejects fallback after uncertain registration", async ({ env }) => {
    addMissingTaskInstallResponses([
      { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
    ]);

    await expect(installGateway(env)).rejects.toThrow(
      "Scheduled Task registration did not confirm completion",
    );

    await expectMissing(resolveStartupFixturePath(env));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects publication when task presence is unknown", async ({ env }) => {
    schtasksRegistration.response = {
      code: 124,
      stdout: "",
      stderr: "schtasks produced no output for 30000ms",
    };
    taskProbe.mockReturnValue({ status: 2, stdout: "-2147024891" });

    await expect(installGateway(env)).rejects.toThrow(
      "Could not back up Scheduled Task OpenClaw Gateway before replacement",
    );

    await expectMissing(resolveTaskScriptPath(env));
    await expectMissing(resolveStartupFixturePath(env));
    expect(spawn).not.toHaveBeenCalled();
    expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
  });

  it("avoids fallback when a listener appears after task exit", async ({ env }) => {
    spawnSync.mockImplementation((command, args) =>
      command === getWindowsPowerShellExePath() && isProcessSnapshotQuery(args)
        ? makeSpawnSyncResult({ status: 1 })
        : makeSpawnSyncResult(),
    );
    fastForwardTaskStartWait();
    verifiedGatewayPids.mockReturnValue([4242]);
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

    await installGateway(env);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not treat gateway liveness as node launch evidence", async ({ env }) => {
    fastForwardTaskStartWait();
    verifiedGatewayPids.mockReturnValue([4242]);
    addAcceptedRunNeverStartsResponses();

    await installNodeScheduledTask(env);

    expect(verifiedGatewayPids).not.toHaveBeenCalled();
    expectStartupFallbackSpawn();
  });

  it("does not relaunch an already-starting task script", async ({ env }) => {
    const taskScriptPath = resolveTaskScriptPath(env);
    fastForwardTaskStartWait();
    mockProcesses(() => [processEntry(4242, `cmd.exe /d /s /c "${taskScriptPath}"`)]);

    addAcceptedRunNeverStartsResponses();

    await installGateway(env);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("uninstalls both Startup formats after hidden opt-in", async ({ env }) => {
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

  it("reports the verified Startup listener", async ({ env, tmpDir }) => {
    taskProbe.mockReturnValue({ status: 1, stdout: "-2147024894" });
    await writeStartupFallbackEntry(env);
    const commandLine = await writeGatewayPackageCommand(path.join(tmpDir, "listener-install"));
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [{ pid: 4242, command: "node.exe", commandLine }]),
    );

    expect(await readScheduledTaskRuntime(env)).toMatchObject({ status: "running", pid: 4242 });
  });

  it("preserves gateway listeners when stopping a node", async ({ env }) => {
    const nodeEnv = makeNodeServiceEnv(env);
    addStartupFallbackMissingResponses();
    await writeStartupFallbackEntry(nodeEnv);
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [
        processListener(5151, 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789'),
      ]),
    );

    spawnSync.mockReturnValueOnce(
      processSnapshot([
        processEntry(5151, 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789'),
      ]),
    );

    await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

    expect(inspectPortUsageMock).not.toHaveBeenCalled();
    expectNoGatewayTermination();
  });

  it.for([false, true])(
    "stops the matching node Startup host (Scheduled Task registered: %s)",
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

  it("restarts the owned Startup process", async ({ env }) => {
    await prepareFallbackRestart(env);
    await expect(restartScheduledTask({ env, stdout: new PassThrough() })).resolves.toEqual({
      outcome: "completed",
    });
    expectGatewayTermination(5151);
    expectStartupFallbackSpawn();
  });

  it.for(["termination", "activation"] as const)(
    "refuses restart after losing authority before %s",
    async (stage, { env }) => {
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
    },
  );

  it("audits Startup fallback termination when relaunch fails", async ({ env }) => {
    await prepareFallbackRestart(env);
    spawn.mockImplementationOnce(() => createSpawnChild(childUnref, new Error("spawn failed")));
    const onMutation = vi.fn();

    await expect(
      restartScheduledTask({ env, stdout: new PassThrough(), onMutation }),
    ).rejects.toThrow("spawn failed");

    expectGatewayTermination(5151);
    expect(childUnref).not.toHaveBeenCalled();
    expect(onMutation).toHaveBeenCalledWith({ mode: "startup-entry-stop" });
    expect(onMutation).not.toHaveBeenCalledWith({ mode: "startup-entry-restart" });
  });

  it("rejects restart with an unverified busy-port owner", async ({ env }) => {
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
