import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { readScheduledTaskRuntime, resolveFallbackRuntime } from "./schtasks-runtime.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

type NativeResult = Pick<SpawnSyncReturns<string>, "stdout" | "stderr" | "status" | "error">;
const native = vi.hoisted(() =>
  vi.fn<(command: string, args?: readonly string[], options?: SpawnSyncOptions) => NativeResult>(),
);
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync: native,
}));

vi.mock("./schtasks-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./schtasks-layout.js")>()),
  readScheduledTaskCommand: vi.fn(async () => command("gateway")),
}));

let now = 0;
let processOutput = "";
let portOutput = "";
let processElapsed = 0;
let schedulerElapsed = 0;
let schedulerMissing = true;
let portElapsed = 0;
let portExit = 0;
let portError: Error | undefined;
let portThrow: Error | undefined;

function result(stdout: string, status = 0, error?: Error): NativeResult {
  return { stdout, stderr: "", status, ...(error ? { error } : {}) };
}

function command(kind: "gateway" | "node"): GatewayServiceCommandConfig {
  return {
    programArguments: ["C:\\node.exe", "C:\\openclaw\\entry.js", kind, "run", "--port", "18789"],
  };
}

const portCalls = () =>
  native.mock.calls.filter(([, args]) => args?.join(" ").includes("Get-NetTCPConnection"));
const snapshot = (...entries: Array<{ ProcessId?: number; CommandLine: string | null }>) =>
  JSON.stringify([{ ProcessId: 111, CommandLine: "powershell.exe Get-CimInstance" }, ...entries]);
const observe = (kind: "gateway" | "node" = "gateway", installed = command(kind)) =>
  resolveFallbackRuntime({ OPENCLAW_SERVICE_KIND: kind }, installed, "observe", 100);

beforeEach(() => {
  mockProcessPlatform("win32");
  vi.spyOn(performance, "now").mockImplementation(() => now);
  now = processElapsed = portElapsed = portExit = schedulerElapsed = 0;
  schedulerMissing = true;
  portError = portThrow = undefined;
  processOutput = snapshot();
  portOutput = "0\r\n";
  native.mockReset();
  native.mockImplementation((_executable, args) => {
    const script = args?.join(" ") ?? "";
    if (args?.includes("-EncodedCommand")) {
      now += schedulerElapsed;
      return schedulerMissing ? result("-2147024894", 1) : result('{"state":4}');
    }
    if (script.includes("Get-CimInstance Win32_Process")) {
      now += processElapsed;
      return result(processOutput);
    }
    if (script.includes("Get-NetTCPConnection")) {
      now += portElapsed;
      if (portThrow) {
        throw portThrow;
      }
      return result(portOutput, portExit, portError);
    }
    throw new Error("Unexpected native inspection");
  });
});
afterEach(() => vi.restoreAllMocks());

it.each(["gateway", "node"] as const)("ignores PID 0 for %s", async (kind) => {
  processOutput = snapshot({ ProcessId: 0, CommandLine: null });
  processElapsed = 40.25;
  const runtime = await observe(kind);
  expect(runtime.status).toBe("stopped");
  expect(runtime.missingUnit).not.toBe(true);
  expect(portCalls()).toHaveLength(kind === "gateway" ? 1 : 0);
  if (kind === "gateway") {
    expect(portCalls()[0]?.[2]?.timeout).toBe(59);
  }
});

it.each(["gateway", "node"] as const)("identifies %s in incomplete snapshots", async (kind) => {
  const installed = command(kind);
  processOutput = JSON.stringify([
    { ProcessId: 111, CommandLine: null },
    { ProcessId: 4242, CommandLine: installed.programArguments.join(" ") },
  ]);
  const runtime = await observe(kind, installed);
  expect(runtime).toMatchObject({ status: "running", pid: 4242 });
  expect(portCalls()).toHaveLength(0);
});

it.each<["gateway" | "node", string, string]>([
  ["gateway", "null command", snapshot({ ProcessId: 222, CommandLine: null })],
  ["gateway", "empty command", snapshot({ ProcessId: 222, CommandLine: "" })],
  ["gateway", "unparseable command", snapshot({ ProcessId: 222, CommandLine: "node\0 gateway" })],
  [
    "gateway",
    "missing pid",
    snapshot({ CommandLine: command("gateway").programArguments.join(" ") }),
  ],
  ["node", "null command", snapshot({ ProcessId: 222, CommandLine: null })],
  ["gateway", "empty output", ""],
  ["gateway", "empty array", "[]"],
  ["gateway", "missing fields", "[{}]"],
  ["gateway", "invalid JSON", "not-json"],
])("keeps %s snapshots with %s unknown", async (kind, _label, output) => {
  processOutput = output;
  const runtime = await observe(kind);
  expect(runtime.status).toBe("unknown");
  expect(runtime.missingUnit).not.toBe(true);
  expect(portCalls()).toHaveLength(0);
});

it.each([
  ["busy listener", "1", 0, 0, 0, 100],
  ["unverifiable count", "", 0, 0, 0, 100],
  ["native failure", "0", 1, 0, 0, 100],
  ["sub-millisecond remainder", "0", 0, 99.75, 0, undefined],
  ["late free observation", "0", 0, 30, 71, 70],
] as const)(
  "does not report stopped after %s",
  async (_label, output, exit, processMs, portMs, timeout) => {
    portOutput = output;
    portExit = exit;
    if (exit) {
      portError = new Error("listener inspection unavailable");
    }
    processElapsed = processMs;
    portElapsed = portMs;
    const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
    expect(runtime.status).toBe("unknown");
    expect(portCalls()).toHaveLength(timeout === undefined ? 0 : 1);
    expect(portCalls()[0]?.[2]?.timeout).toBe(timeout);
  },
);

it("retains a listener cleanup refusal rather than reporting stopped", async () => {
  const error = new CommandProcessCleanupError();
  portThrow = error;
  const inspection = resolveFallbackRuntime({}, command("gateway"), "observe", 100);
  await expect(inspection).rejects.toBe(error);
});
it.each([
  { queryMs: 40, expired: false },
  { queryMs: 100, expired: true },
])("charges registered query $queryMs ms to its deadline", async ({ queryMs, expired }) => {
  const { readScheduledTaskCommand } =
    await vi.importActual<typeof import("./schtasks-layout.js")>("./schtasks-layout.js");
  const taskName = "\\Custom\\Gateway";
  const action = {
    type: 0,
    path: "C:\\node.exe",
    arguments: '"C:\\openclaw\\entry.js" gateway',
    workingDirectory: "",
  };
  native.mockImplementation(() => {
    now += queryMs;
    return result(JSON.stringify({ taskPath: taskName, state: 4, actions: [action] }));
  });
  const inspection = readScheduledTaskCommand(
    { OPENCLAW_WINDOWS_TASK_NAME: taskName },
    { requireLoaded: true, timeoutMs: 100 },
  );
  if (expired) {
    await expect(inspection).rejects.toMatchObject({
      reason: "windows-task-inspection-failed",
      timeoutMs: 0,
    });
  } else {
    await expect(inspection).resolves.toMatchObject({
      programArguments: [action.path, "C:\\openclaw\\entry.js", "gateway"],
    });
  }
  expect(native).toHaveBeenCalledOnce();
  expect(native.mock.calls.map((call) => call[2]?.timeout)).toEqual([100]);
});

it.each([
  { queryMs: 40, processMs: 30, missing: true },
  { queryMs: 100, processMs: 0, missing: false },
])("shares the deadline after $queryMs ms", async ({ queryMs, processMs, missing }) => {
  if (missing) {
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
  }
  schedulerMissing = missing;
  schedulerElapsed = queryMs;
  processElapsed = processMs;
  const inspection = readScheduledTaskRuntime(
    missing ? { APPDATA: "C:\\fixture", OPENCLAW_SERVICE_KIND: "gateway" } : {},
    { timeoutMs: 100 },
  );
  if (missing) {
    await expect(inspection).resolves.toMatchObject({ status: "stopped" });
    expect(native.mock.calls.map((call) => call[2]?.timeout)).toEqual([100, 60, 30]);
  } else {
    await expect(inspection).rejects.toThrow("Scheduled Task inspection deadline expired");
    expect(native).toHaveBeenCalledTimes(1);
  }
});
