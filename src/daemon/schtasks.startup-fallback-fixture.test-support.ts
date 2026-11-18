import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it as baseIt, vi } from "vitest";
import type { PortUsage } from "../infra/ports-types.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
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
  inspectPortUsageMock,
  isProcessSnapshotQuery,
  killProcessTreeMock,
  makeSpawnSyncResult,
  resetSchtasksBaseMocks,
  schtasksResponses,
  schtasksRegistration,
  withWindowsEnv as withBaseWindowsEnv,
  type SpawnSyncResult,
  type NativeResponse,
} from "./test-helpers/schtasks-fixtures.js";

type WindowsFixture = Parameters<Parameters<typeof withBaseWindowsEnv>[1]>[0];
let fixtureEnv: Record<string, string>;
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

const { runScheduledTaskOrThrow } = await import("./schtasks-control.js");
const { installScheduledTask } = await import("./schtasks-install.js");
const { resolveTaskScriptPath } = await import("./schtasks-layout.js");

const INSTALLED_GATEWAY_COMMAND =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789';
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

function makeNodeServiceEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    OPENCLAW_SERVICE_KIND: "node",
    OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
  };
}

function portUsage(
  status: PortUsage["status"],
  listeners: PortUsage["listeners"] = [],
  port = 18789,
): PortUsage {
  return { port, status, listeners, hints: [] };
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

export {
  runScheduledTaskOrThrow,
  resolveTaskScriptPath,
  POWERSHELL_PROCESS,
  addAcceptedRunNeverStartsResponses,
  expectNoGatewayTermination,
  fastForwardTaskStartWait,
  installGateway,
  it,
  makeNodeServiceEnv,
  mockProcesses,
  processEntry,
  sleepMock,
  spawn,
  spawnSync,
  taskProbe,
  timeState,
};
