import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WindowsProcessSnapshotEntry } from "./schtasks-process-snapshot.js";
import { readScheduledTaskRuntime, resolveFallbackRuntime } from "./schtasks-runtime.js";
import type { GatewayServiceReadOptions } from "./service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";
import {
  formatWindowsTaskSupervisorChildArgument,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "./windows-task-supervisor-contract.js";

const { native, resetNative } = vi.hoisted(() => {
  const defaults = () => ({
    command: ["C:\\runtime-b\\node.exe", "C:\\openclaw\\entry.js", "gateway", "--port", "18789"],
    processes: [] as WindowsProcessSnapshotEntry[] | null,
    state: 4,
    ownerAlive: false,
    ownerPid: 42,
    ownerPort: 18789,
    ownerTask: "OpenClaw Gateway",
    environment: undefined as Record<string, string> | undefined,
    reads: 0,
    changed: undefined as "present" | "absent" | "unavailable" | undefined,
  });
  const fixture = defaults();
  return { native: fixture, resetNative: () => Object.assign(fixture, defaults()) };
});
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
  resetNative();
});

function environmentPort() {
  native.command = native.command.slice(0, -2);
  native.environment = { OPENCLAW_GATEWAY_PORT: "18789" };
}
function processEntry(pid = 42, argv = native.command) {
  return { ProcessId: pid, CommandLine: argv.join(" ") };
}
function controlRuntime() {
  const installed = { programArguments: native.command, environment: native.environment };
  return resolveFallbackRuntime({}, installed, "control", performance.now() + 5_000);
}
async function expectUnidentified(status = "unknown") {
  const runtime = await readScheduledTaskRuntime({});
  expect(runtime).toMatchObject({ status });
  expect(runtime.pid).toBeUndefined();
  return runtime;
}

it.each<[string, Partial<typeof native>]>([
  ["direct", {}],
  ["supervised", {}],
  ["other-pid", { ownerPid: 43 }],
  ["other-port", { ownerPort: 19848 }],
  ["other-task", { ownerTask: "Another Gateway" }],
  ["other-command", {}],
  ["unowned", { ownerAlive: false }],
])("binds an environment-only port to its exact Gateway owner (%s)", async (kind, owner) => {
  environmentPort();
  Object.assign(native, { ownerAlive: true }, owner);
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

it("keeps an unleased environment-only child unknown before ownership is published", async () => {
  native.state = 3;
  environmentPort();
  native.processes = [processEntry()];
  expect((await readScheduledTaskRuntime({})).status).toBe("unknown");
  expect(await controlRuntime()).toMatchObject({ status: "unknown" });
});

// Server 2022 returns these native image names without readable command lines.
const protectedProcesses = [
  { ProcessId: 0, Name: "System Idle Process", CommandLine: null },
  { ProcessId: 4, Name: "System", CommandLine: null },
  { ProcessId: 2604, Name: "MpDefenderCoreService.exe", CommandLine: null },
  { ProcessId: 9999, Name: "powershell.exe", CommandLine: "powershell.exe -NoProfile" },
];

it.each([
  { executable: "C:\\runtime-b\\bun.exe", expected: "stopped", unreadable: false },
  { executable: "node.exe", expected: "unknown", unreadable: false },
  { executable: "C:\\runtime-b\\node.exe", expected: "unknown", unreadable: true },
])(
  "classifies protected images for $executable (unreadable image=$unreadable)",
  async ({ executable, expected, unreadable }) => {
    native.state = 3;
    native.command[0] = executable;
    native.processes = unreadable
      ? [...protectedProcesses, { ProcessId: 42, Name: undefined, CommandLine: null }]
      : protectedProcesses;
    await expectUnidentified(expected);
  },
);

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

it.each<[number, string]>([
  [4, "Running"],
  [3, "Ready"],
])(
  "keeps the old task owner unknown after definition replacement (state %s)",
  async (state, name) => {
    native.state = state;
    native.ownerAlive = true;
    native.processes = [processEntry(42, ["C:\\runtime-a\\node.exe", ...native.command.slice(1)])];
    const options = state === 4 ? { timeoutMs: 5_000 } : undefined;
    const runtime = await readScheduledTaskRuntime({}, options);
    expect(runtime).toMatchObject({ status: "unknown", state: name });
    expect(runtime.pid).toBeUndefined();
  },
);

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

it.each([false, true])(
  "blocks stopped publication with a surviving supervisor (env port=%s)",
  async (envPort) => {
    if (envPort) {
      environmentPort();
    }
    native.processes = [
      ...(envPort ? [] : protectedProcesses),
      {
        ...(envPort ? {} : { Name: "node.exe" }),
        ...processEntry(42, [...native.command, WINDOWS_TASK_SUPERVISOR_FLAG]),
      },
    ];
    expect(await controlRuntime()).toMatchObject({ status: "unknown" });
  },
);

it.each([
  ["unavailable", null, "unknown"],
  ["incomplete", [{ ProcessId: 42, CommandLine: null }], "unknown"],
  ["confirmed absence", [{ ProcessId: 43, CommandLine: "powershell.exe" }], "stopped"],
] as const)(
  "keeps unreadable process evidence distinct from absence (%s)",
  async (_evidence, snapshot, expected) => {
    native.state = 3;
    native.processes = snapshot === null ? null : [...snapshot];
    expect((await expectUnidentified(expected)).state).toBe("Ready");
  },
);
