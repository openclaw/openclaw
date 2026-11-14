import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it as baseIt, vi } from "vitest";
import type { PortUsage } from "../infra/ports-types.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import { readWindowsStartupFallbackRuntimeForUpdate } from "./schtasks-runtime.js";
import {
  timeState,
  sleepMock,
  childUnref,
  spawn,
  spawnSync,
  taskProbe,
  verifiedGatewayPids,
} from "./schtasks.startup-fallback-mocks.test-support.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import {
  createSpawnChild,
  createSchtasksNativeFixture,
  notYetRunTaskSnapshot,
  runningTaskSnapshot,
  inspectPortUsageMock,
  isProcessSnapshotQuery,
  killProcessTreeMock,
  makeSpawnSyncResult,
  resetSchtasksBaseMocks,
  schtasksCalls,
  schtasksResponses,
  schtasksRegistration,
  withWindowsEnv as withBaseWindowsEnv,
  writeGatewayScript,
  writeNodeScript as writeBaseNodeScript,
  writeStartupFallbackEntry,
  type SpawnSyncResult,
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

const nativeTask = createSchtasksNativeFixture(() => fixtureEnv);
const { queue: queueNativeResponses, advance: advanceTaskProbe } = nativeTask;

const { restartScheduledTask, stopScheduledTask, runScheduledTaskOrThrow } =
  await import("./schtasks-control.js");
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

function holdQueuedTaskProbesUntilRunCount(runCount: number) {
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
    if (schtasksCalls.filter(([action]) => action === "/Run").length >= runCount) {
      advanceTaskProbe();
    }
  });
}

function holdCurrentTaskProbe() {
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
  });
}

export {
  runScheduledTaskOrThrow,
  queueNativeResponses,
  readWindowsStartupFallbackRuntimeForUpdate,
  readScheduledTaskRuntime,
  removeStartupEntries,
  resolveTaskScriptPath,
  restartScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
  INSTALLED_GATEWAY_COMMAND,
  NODE_HOST_COMMAND,
  OTHER_GATEWAY_COMMAND,
  POWERSHELL_PROCESS,
  addAcceptedRunNeverStartsResponses,
  addMissingTaskInstallResponses,
  addStartupFallbackMissingResponses,
  addSuccessfulMigrationResponses,
  addSuccessfulScheduledTaskRestartResponses,
  childUnref,
  expectGatewayTermination,
  expectMissing,
  expectNoGatewayTermination,
  expectStartupFallbackSpawn,
  expectTaskkillPid,
  fastForwardTaskStartWait,
  holdCurrentTaskProbe,
  holdQueuedTaskProbesUntilRunCount,
  installGateway,
  installNodeScheduledTask,
  it,
  makeNodeServiceEnv,
  mockProcesses,
  mockTerminatingProcess,
  portUsage,
  prepareFallbackRestart,
  processEntry,
  processListener,
  processSnapshot,
  readScript,
  sleepMock,
  spawn,
  spawnSync,
  successfulResponses,
  taskProbe,
  timeState,
  verifiedGatewayPids,
  writeGatewayFallback,
  writeGatewayPackageCommand,
  writeNodeScript,
  writeRunningGatewayScript,
};
