import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readScheduledTaskRuntime, resolveFallbackRuntime } from "./schtasks-runtime.js";
import type { GatewayServiceReadOptions } from "./service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";
import {
  formatWindowsTaskSupervisorChildArgument,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "./windows-task-supervisor-contract.js";

const native = vi.hoisted(() => ({
  command: ["C:\\runtime-b\\node.exe", "C:\\openclaw\\entry.js", "gateway", "--port", "18789"],
  processes: [{ ProcessId: 42, CommandLine: "" }] as Array<{
    ProcessId: number;
    CommandLine: string | null;
    Name?: string | null;
  }> | null,
  state: 4,
  ownerAlive: false,
  ownerPid: 42,
  ownerPort: 18789,
  ownerTask: "OpenClaw Gateway",
  environment: undefined as Record<string, string> | undefined,
  reads: 0,
  changed: undefined as "present" | "absent" | "unavailable" | undefined,
}));
vi.mock("./schtasks-layout.js", async (original) => ({
  ...(await original<typeof import("./schtasks-layout.js")>()),
  readScheduledTaskCommand: async (_env: unknown, options?: GatewayServiceReadOptions) => {
    const first = native.changed && native.reads++ === 0;
    if (first && native.changed === "absent") {
      options?.onCommandInspection?.({ kind: "absent" });
      return null;
    }
    if (first && native.changed === "unavailable") {
      const error = new Error("Synthetic initial inspection failure");
      options?.onCommandInspection?.({ kind: "unavailable", error });
      throw error;
    }
    const command = {
      programArguments: first
        ? ["C:\\runtime-a\\node.exe", ...native.command.slice(1)]
        : native.command,
      ...(native.environment ? { environment: native.environment } : {}),
    };
    options?.onCommandInspection?.({ kind: "present", command });
    return command;
  },
}));
vi.mock("./schtasks-state-probe.js", async (original) => ({
  ...(await original<typeof import("./schtasks-state-probe.js")>()),
  probeScheduledTaskState: () => ({ status: "found", state: native.state }),
}));
vi.mock("./schtasks-process-snapshot.js", async (original) => ({
  ...(await original<typeof import("./schtasks-process-snapshot.js")>()),
  readWindowsProcessSnapshot: () => native.processes,
}));
vi.mock("../infra/windows-port-pids.js", async (original) => ({
  ...(await original<typeof import("../infra/windows-port-pids.js")>()),
  readWindowsPortUsageSync: () => "free",
}));
// mock-isolation: Synthetic task ownership must not read the real Gateway lease database.
vi.mock("../infra/gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: () =>
    native.ownerAlive
      ? {
          state: "live",
          pid: native.ownerPid,
          port: native.ownerPort,
          supervisor: { kind: "schtasks", name: native.ownerTask },
        }
      : undefined,
}));
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  native.changed = undefined;
  native.reads = 0;
  native.state = 4;
  native.ownerAlive = false;
  native.ownerPid = 42;
  native.ownerPort = 18789;
  native.ownerTask = "OpenClaw Gateway";
  native.environment = undefined;
  native.command = [
    "C:\\runtime-b\\node.exe",
    "C:\\openclaw\\entry.js",
    "gateway",
    "--port",
    "18789",
  ];
});

function environmentPort() {
  native.command = native.command.slice(0, -2);
  native.environment = { OPENCLAW_GATEWAY_PORT: "18789" };
}
function processEntry(pid = 42, argv = native.command) {
  return { ProcessId: pid, CommandLine: argv.join(" ") };
}
function controlRuntime() {
  return resolveFallbackRuntime(
    {},
    {
      programArguments: native.command,
      environment: native.environment,
    },
    "control",
    performance.now() + 5_000,
  );
}
async function expectUnidentified(status = "unknown") {
  const runtime = await readScheduledTaskRuntime({});
  expect(runtime).toMatchObject({ status });
  expect(runtime.pid).toBeUndefined();
  return runtime;
}

it.each([
  "direct",
  "supervised",
  "other-pid",
  "other-port",
  "other-task",
  "other-command",
  "unowned",
])("binds an environment-only port to its exact Gateway owner (%s)", async (kind) => {
  environmentPort();
  native.ownerAlive = kind !== "unowned";
  if (kind === "other-pid") {
    native.ownerPid = 43;
  }
  if (kind === "other-port") {
    native.ownerPort = 19848;
  }
  if (kind === "other-task") {
    native.ownerTask = "Another Gateway";
  }
  const actual =
    kind === "other-command"
      ? ["C:\\runtime-a\\node.exe", ...native.command.slice(1)]
      : native.command;
  native.processes = [
    processEntry(
      42,
      kind === "supervised" ? [...actual, formatWindowsTaskSupervisorChildArgument(65536)] : actual,
    ),
  ];
  const runtime = await readScheduledTaskRuntime({});
  const matches = kind === "direct" || kind === "supervised";
  expect(runtime.status).toBe(matches ? "running" : "unknown");
  expect(runtime.pid).toBe(matches ? 42 : undefined);
});

it("does not admit an environment-only port while its unleased supervisor survives", async () => {
  environmentPort();
  native.processes = [processEntry(42, [...native.command, WINDOWS_TASK_SUPERVISOR_FLAG])];
  const runtime = await controlRuntime();
  expect(runtime.status).toBe("unknown");
});

it("keeps an unleased environment-only child unknown before ownership is published", async () => {
  native.state = 3;
  environmentPort();
  native.processes = [processEntry()];
  expect((await readScheduledTaskRuntime({})).status).toBe("unknown");
  const runtime = await controlRuntime();
  expect(runtime.status).toBe("unknown");
});

// Server 2022 returns these native image names without readable command lines.
const protectedProcesses = [
  { ProcessId: 0, Name: "System Idle Process", CommandLine: null },
  { ProcessId: 4, Name: "System", CommandLine: null },
  { ProcessId: 2604, Name: "MpDefenderCoreService.exe", CommandLine: null },
  { ProcessId: 9999, Name: "powershell.exe", CommandLine: "powershell.exe -NoProfile" },
];

it.each([
  { executable: "C:\\runtime-b\\bun.exe", expected: "stopped" },
  { executable: "node.exe", expected: "unknown" },
])(
  "classifies unrelated protected native images only for $executable",
  async ({ executable, expected }) => {
    native.state = 3;
    native.command[0] = executable;
    native.processes = protectedProcesses;
    await expectUnidentified(expected);
  },
);

it("retains unknown process evidence for an unreadable image", async () => {
  native.state = 3;
  native.processes = [...protectedProcesses, { ProcessId: 42, Name: undefined, CommandLine: null }];
  await expectUnidentified();
});

it.each(["present", "absent", "unavailable"] as const)(
  "does not combine an earlier %s observation with a later matching runtime",
  async (initial) => {
    native.changed = initial;
    native.processes = [processEntry(43)];
    const state = await readGatewayServiceState(resolveGatewayService(), { env: {} });
    expect(state.command?.programArguments[0]).toBe(
      initial === "present" ? "C:\\runtime-a\\node.exe" : undefined,
    );
    expect(state.running).toBe(false);
    expect(state.runtime?.status).toBe("unknown");
  },
);
afterEach(() => vi.restoreAllMocks());

it("does not report the replacement definition running on the old task owner", async () => {
  native.ownerAlive = true;
  native.processes = [processEntry(42, ["C:\\runtime-a\\node.exe", ...native.command.slice(1)])];
  const runtime = await readScheduledTaskRuntime({}, { timeoutMs: 5_000 });
  expect(runtime).toMatchObject({ status: "unknown", state: "Running" });
  expect(runtime.pid).toBeUndefined();
});

it("does not describe an old owned Gateway as stopped after its definition changed", async () => {
  native.state = 3;
  native.ownerAlive = true;
  native.processes = [processEntry(42, ["C:\\runtime-a\\node.exe", ...native.command.slice(1)])];
  await expectUnidentified();
});

it("reports the process matching the installed command, excluding its task supervisor", async () => {
  native.processes = [
    processEntry(42, [...native.command, WINDOWS_TASK_SUPERVISOR_FLAG]),
    processEntry(43),
  ];
  expect(await readScheduledTaskRuntime({})).toMatchObject({ status: "running", pid: 43 });
});

it("keeps a surviving supervisor without its child unknown", async () => {
  native.state = 3;
  native.processes = [processEntry(42, [...native.command, WINDOWS_TASK_SUPERVISOR_FLAG])];
  await expectUnidentified();
});

it("does not admit stopped publication while the exact task supervisor survives on a free port", async () => {
  native.processes = [
    ...protectedProcesses,
    {
      Name: "node.exe",
      ...processEntry(42, [...native.command, WINDOWS_TASK_SUPERVISOR_FLAG]),
    },
  ];
  const runtime = await controlRuntime();
  expect(runtime.status).toBe("unknown");
});

it.each([
  { evidence: "unavailable", snapshot: null, expected: "unknown" },
  {
    evidence: "incomplete",
    snapshot: [{ ProcessId: 42, CommandLine: null }],
    expected: "unknown",
  },
  {
    evidence: "confirmed absence",
    snapshot: [{ ProcessId: 43, CommandLine: "powershell.exe" }],
    expected: "stopped",
  },
])(
  "keeps unreadable process evidence distinct from absence ($evidence)",
  async ({ snapshot, expected }) => {
    native.state = 3;
    native.processes = snapshot;
    expect((await expectUnidentified(expected)).state).toBe("Ready");
  },
);
