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
    "preserves observed stopped %s runtime with a deadline",
    async (kind) => {
      const runtime = await resolveFallbackRuntime(
        { OPENCLAW_SERVICE_KIND: kind },
        command(kind),
        "observe",
        100,
      );
      expect(runtime.status).toBe("stopped");
      expect(runtime.missingUnit).not.toBe(true);
      expect(portCalls()).toHaveLength(kind === "gateway" ? 1 : 0);
    },
  );

  it.each(["gateway", "node"] as const)(
    "ignores the System Idle Process when proving stopped %s runtime",
    async (kind) => {
      processOutput = JSON.stringify([
        { ProcessId: 0, CommandLine: null },
        { ProcessId: 111, CommandLine: "powershell.exe Get-CimInstance" },
      ]);
      const runtime = await resolveFallbackRuntime(
        { OPENCLAW_SERVICE_KIND: kind },
        command(kind),
        "observe",
        100,
      );
      expect(runtime.status).toBe("stopped");
      expect(portCalls()).toHaveLength(kind === "gateway" ? 1 : 0);
    },
  );

  it.each(["gateway", "node"] as const)(
    "retains exact running %s process evidence",
    async (kind) => {
      const installed = command(kind);
      processOutput = JSON.stringify([
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

  it.each(
    (["gateway", "node"] as const).flatMap((kind) =>
      [
        { label: "null command line", entry: { ProcessId: 222, CommandLine: null } },
        { label: "missing command line", entry: { ProcessId: 222 } },
        { label: "empty command line", entry: { ProcessId: 222, CommandLine: "" } },
        { label: "blank command line", entry: { ProcessId: 222, CommandLine: "  " } },
        {
          label: "missing process identity",
          entry: { CommandLine: command(kind).programArguments.join(" ") },
        },
      ].map(({ label, entry }) => ({ kind, label, entry })),
    ),
  )("keeps incomplete $kind snapshot with $label unknown", async ({ kind, entry }) => {
    processOutput = JSON.stringify([
      { ProcessId: 111, CommandLine: "powershell.exe Get-CimInstance" },
      entry,
    ]);
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

  it.each(["gateway", "node"] as const)(
    "retains positive %s process identity in an incomplete snapshot",
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

  it.each(["", "[]", "[{}]", "not-json"])(
    "does not treat unavailable snapshot %j as stopped",
    async (output) => {
      processOutput = output;
      const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
      expect(runtime.status).toBe("unknown");
      expect(portCalls()).toHaveLength(0);
    },
  );

  it.each(["1", "2", "", "not-a-count", "-1"])(
    "keeps busy or unverifiable listener result %j unknown",
    async (output) => {
      portOutput = output;
      const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
      expect(runtime.status).toBe("unknown");
      expect(portCalls()).toHaveLength(1);
    },
  );

  it("does not collapse native listener failure into a successful empty result", async () => {
    portExit = 1;
    portError = new Error("listener inspection unavailable");
    const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
    expect(runtime.status).toBe("unknown");
  });

  it("debits process time before the listener read without fractional timeout inflation", async () => {
    processElapsed = 40.25;
    const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
    expect(runtime.status).toBe("stopped");
    expect(portCalls()[0]?.[2]?.timeout).toBe(59);
  });

  it("does not admit a listener read with a sub-millisecond remainder", async () => {
    processElapsed = 99.75;
    const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
    expect(runtime.status).toBe("unknown");
    expect(portCalls()).toHaveLength(0);
  });

  it("does not accept a free listener observation completed after the shared deadline", async () => {
    processElapsed = 30;
    portElapsed = 71;
    const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
    expect(runtime.status).toBe("unknown");
    expect(portCalls()[0]?.[2]?.timeout).toBe(70);
  });

  it("retains a listener cleanup refusal rather than reporting stopped", async () => {
    const error = new CommandProcessCleanupError();
    portThrow = error;
    await expect(resolveFallbackRuntime({}, command("gateway"), "observe", 100)).rejects.toBe(
      error,
    );
  });
});

describe("Scheduled Task runtime inspection budget", () => {
  it("charges the native query before Startup process and listener inspection", async () => {
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
    schedulerElapsed = 40;
    processElapsed = 30;

    const runtime = await readScheduledTaskRuntime(
      { APPDATA: "C:\\fixture", OPENCLAW_SERVICE_KIND: "gateway" },
      { timeoutMs: 100 },
    );

    expect(runtime.status).toBe("stopped");
    expect(native.mock.calls.map((call) => call[2]?.timeout)).toEqual([100, 60, 30]);
  });

  it("does not inspect processes after the native query exhausts its allowance", async () => {
    schedulerMissing = false;
    schedulerElapsed = 100;

    await expect(readScheduledTaskRuntime({}, { timeoutMs: 100 })).rejects.toThrow(
      "Scheduled Task inspection deadline expired",
    );
    expect(native).toHaveBeenCalledTimes(1);
  });
});
