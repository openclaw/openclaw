import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { readScheduledTaskRuntime, resolveFallbackRuntime } from "./schtasks-runtime.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

type NativeResult = {
  pid: number;
  output: (string | null)[];
  stdout: string;
  stderr: string;
  status: number | null;
  signal: null;
  error?: Error;
};

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
  return {
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status,
    signal: null,
    ...(error ? { error } : {}),
  };
}

function command(kind: "gateway" | "node"): GatewayServiceCommandConfig {
  return {
    programArguments: ["C:\\node.exe", "C:\\openclaw\\entry.js", kind, "run", "--port", "18789"],
  };
}

const portCalls = () =>
  native.mock.calls.filter(([, args]) => args?.join(" ").includes("Get-NetTCPConnection"));

beforeEach(() => {
  mockProcessPlatform("win32");
  vi.spyOn(performance, "now").mockImplementation(() => now);
  now = processElapsed = portElapsed = portExit = schedulerElapsed = 0;
  schedulerMissing = true;
  portError = portThrow = undefined;
  processOutput = JSON.stringify([
    { ProcessId: 111, CommandLine: "powershell.exe Get-CimInstance" },
  ]);
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

describe("bounded Startup runtime observations", () => {
  it.each(["gateway", "node"] as const)(
    "ignores the System Idle Process when proving stopped %s runtime within the shared budget",
    async (kind) => {
      processOutput = JSON.stringify([
        { ProcessId: 0, CommandLine: null },
        { ProcessId: 111, CommandLine: "powershell.exe Get-CimInstance" },
      ]);
      processElapsed = 40.25;
      const runtime = await resolveFallbackRuntime(
        { OPENCLAW_SERVICE_KIND: kind },
        command(kind),
        "observe",
        100,
      );
      expect(runtime.status).toBe("stopped");
      expect(runtime.missingUnit).not.toBe(true);
      expect(portCalls()).toHaveLength(kind === "gateway" ? 1 : 0);
      if (kind === "gateway") {
        expect(portCalls()[0]?.[2]?.timeout).toBe(59);
      }
    },
  );

  it.each(["gateway", "node"] as const)(
    "retains exact %s process identity even in an incomplete snapshot",
    async (kind) => {
      const installed = command(kind);
      processOutput = JSON.stringify([
        { ProcessId: 111, CommandLine: null },
        { ProcessId: 4242, CommandLine: installed.programArguments.join(" ") },
      ]);
      const runtime = await resolveFallbackRuntime(
        { OPENCLAW_SERVICE_KIND: kind },
        installed,
        "observe",
        100,
      );
      expect(runtime).toMatchObject({ status: "running", pid: 4242 });
      expect(portCalls()).toHaveLength(0);
    },
  );

  it.each([
    ...(
      [
        ["gateway", "null command line", { ProcessId: 222, CommandLine: null }],
        ["gateway", "empty command line", { ProcessId: 222, CommandLine: "" }],
        ["gateway", "unparseable command line", { ProcessId: 222, CommandLine: "node\0 gateway" }],
        [
          "gateway",
          "missing process identity",
          { CommandLine: command("gateway").programArguments.join(" ") },
        ],
        ["node", "null command line", { ProcessId: 222, CommandLine: null }],
      ] as const
    ).map(([kind, label, entry]) => ({
      kind,
      label,
      output: JSON.stringify([
        { ProcessId: 111, CommandLine: "powershell.exe Get-CimInstance" },
        entry,
      ]),
    })),
    ...["", "[]", "[{}]", "not-json"].map((output) => ({
      kind: "gateway" as const,
      label: `unavailable ${JSON.stringify(output)}`,
      output,
    })),
  ])("keeps $kind snapshots with $label unknown", async ({ kind, output }) => {
    processOutput = output;
    const runtime = await resolveFallbackRuntime(
      { OPENCLAW_SERVICE_KIND: kind },
      command(kind),
      "observe",
      100,
    );
    expect(runtime.status).toBe("unknown");
    expect(runtime.missingUnit).not.toBe(true);
    expect(portCalls()).toHaveLength(0);
  });

  it.each([
    { label: "busy listener", output: "1", exit: 0, processMs: 0, portMs: 0, timeout: 100 },
    { label: "unverifiable count", output: "", exit: 0, processMs: 0, portMs: 0, timeout: 100 },
    { label: "native failure", output: "0", exit: 1, processMs: 0, portMs: 0, timeout: 100 },
    {
      label: "sub-millisecond remainder",
      output: "0",
      exit: 0,
      processMs: 99.75,
      portMs: 0,
      timeout: undefined,
    },
    {
      label: "late free observation",
      output: "0",
      exit: 0,
      processMs: 30,
      portMs: 71,
      timeout: 70,
    },
  ])(
    "does not report stopped after $label",
    async ({ output, exit, processMs, portMs, timeout }) => {
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
    await expect(resolveFallbackRuntime({}, command("gateway"), "observe", 100)).rejects.toBe(
      error,
    );
  });
});

describe("Scheduled Task runtime inspection budget", () => {
  it.each([
    { queryMs: 40, revalidationMs: 40, expired: false, calls: 2 },
    { queryMs: 100, revalidationMs: 0, expired: true, calls: 1 },
    { queryMs: 40, revalidationMs: 60, expired: true, calls: 2 },
  ])(
    "charges registered query $queryMs ms and revalidation $revalidationMs ms to one deadline",
    async ({ queryMs, revalidationMs, expired, calls }) => {
      const { readScheduledTaskCommand } =
        await vi.importActual<typeof import("./schtasks-layout.js")>("./schtasks-layout.js");
      const taskName = "\\Custom\\Gateway";
      const action = {
        type: 0,
        path: "C:\\node.exe",
        arguments: '"C:\\openclaw\\entry.js" gateway',
        workingDirectory: "",
      };
      let queries = 0;
      native.mockImplementation(() => {
        now += queries++ === 0 ? queryMs : revalidationMs;
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
      expect(native).toHaveBeenCalledTimes(calls);
      expect(native.mock.calls.map((call) => call[2]?.timeout)).toEqual(
        calls === 1 ? [100] : [100, 60],
      );
    },
  );

  it.each([
    { queryMs: 40, processMs: 30, missing: true },
    { queryMs: 100, processMs: 0, missing: false },
  ])(
    "charges the native query $queryMs ms before process inspection",
    async ({ queryMs, processMs, missing }) => {
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
    },
  );
});
