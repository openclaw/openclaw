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

it.each([
  "direct",
  "supervised",
  "other-pid",
  "other-port",
  "other-task",
  "other-command",
  "unowned",
])("binds an environment-only port to its exact Gateway owner (%s)", async (kind) => {
  native.command = native.command.slice(0, -2);
  native.environment = { OPENCLAW_GATEWAY_PORT: "18789" };
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
    {
      ProcessId: 42,
      CommandLine: (kind === "supervised"
        ? [...actual, formatWindowsTaskSupervisorChildArgument(65536)]
        : actual
      ).join(" "),
    },
  ];
  const runtime = await readScheduledTaskRuntime({});
  const matches = kind === "direct" || kind === "supervised";
  expect(runtime.status).toBe(matches ? "running" : "unknown");
  expect(runtime.pid).toBe(matches ? 42 : undefined);
});

it("does not admit an environment-only port while its unleased supervisor survives", async () => {
  native.command = native.command.slice(0, -2);
  native.environment = { OPENCLAW_GATEWAY_PORT: "18789" };
  native.processes = [
    { ProcessId: 42, CommandLine: [...native.command, WINDOWS_TASK_SUPERVISOR_FLAG].join(" ") },
  ];
  const runtime = await resolveFallbackRuntime(
    {},
    { programArguments: native.command, environment: native.environment },
    "control",
    performance.now() + 5_000,
  );
  expect(runtime.status).toBe("unknown");
});

it("keeps an unleased environment-only child unknown before ownership is published", async () => {
  native.state = 3;
  native.command = native.command.slice(0, -2);
  native.environment = { OPENCLAW_GATEWAY_PORT: "18789" };
  native.processes = [{ ProcessId: 42, CommandLine: native.command.join(" ") }];
  expect((await readScheduledTaskRuntime({})).status).toBe("unknown");
  const runtime = await resolveFallbackRuntime(
    {},
    { programArguments: native.command, environment: native.environment },
    "control",
    performance.now() + 5_000,
  );
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
  { executable: "C:\\runtime-b\\node.exe", expected: "stopped" },
  { executable: "C:\\runtime-b\\bun.exe", expected: "stopped" },
  { executable: "C:\\runtime-b\\gateway.cmd", expected: "unknown" },
  { executable: "node.exe", expected: "unknown" },
  { executable: "%RUNTIME%\\node.exe", expected: "unknown" },
])(
  "classifies unrelated protected native images only for $executable",
  async ({ executable, expected }) => {
    native.state = 3;
    native.command[0] = executable;
    native.processes = protectedProcesses;
    const runtime = await readScheduledTaskRuntime({});
    expect(runtime.status).toBe(expected);
    expect(runtime.pid).toBeUndefined();
  },
);

it.each(["NODE.EXE", undefined, null, "C:\\another\\other.exe"])(
  "retains unknown process evidence for an unreadable image %s",
  async (Name) => {
    native.state = 3;
    native.processes = [...protectedProcesses, { ProcessId: 42, Name, CommandLine: null }];
    const runtime = await readScheduledTaskRuntime({});
    expect(runtime.status).toBe("unknown");
    expect(runtime.pid).toBeUndefined();
  },
);

it.each(["present", "absent", "unavailable"] as const)(
  "does not combine an earlier %s observation with a later matching runtime",
  async (initial) => {
    native.changed = initial;
    native.processes = [{ ProcessId: 43, CommandLine: native.command.join(" ") }];
    const state = await readGatewayServiceState(resolveGatewayService(), { env: {} });
    expect(state.command?.programArguments[0]).toBe(
      initial === "present" ? "C:\\runtime-a\\node.exe" : undefined,
    );
    expect(state.running).toBe(false);
    expect(state.runtime?.status).toBe("unknown");
  },
);
afterEach(() => vi.restoreAllMocks());

it.each([undefined, 5_000])(
  "does not report the replacement definition running on the old task owner (budget %s)",
  async (timeoutMs) => {
    native.ownerAlive = true;
    native.processes = [
      {
        ProcessId: 42,
        CommandLine: ["C:\\runtime-a\\node.exe", ...native.command.slice(1)].join(" "),
      },
    ];
    const runtime = await readScheduledTaskRuntime({}, { timeoutMs });
    expect(runtime).toMatchObject({ status: "unknown", state: "Running" });
    expect(runtime.pid).toBeUndefined();
  },
);

it.each([1, 3])(
  "does not describe an old owned Gateway as stopped after its definition changed (state %s)",
  async (state) => {
    native.state = state;
    native.ownerAlive = true;
    native.processes = [
      {
        ProcessId: 42,
        CommandLine: ["C:\\runtime-a\\node.exe", ...native.command.slice(1)].join(" "),
      },
    ];
    const runtime = await readScheduledTaskRuntime({});
    expect(runtime.status).toBe("unknown");
    expect(runtime.pid).toBeUndefined();
  },
);

it("reports the process matching the installed command, excluding its task supervisor", async () => {
  native.processes = [
    { ProcessId: 42, CommandLine: [...native.command, WINDOWS_TASK_SUPERVISOR_FLAG].join(" ") },
    { ProcessId: 43, CommandLine: native.command.join(" ") },
  ];
  expect(await readScheduledTaskRuntime({})).toMatchObject({ status: "running", pid: 43 });
});

it.each([1, 3, 4])(
  "keeps a surviving supervisor without its child unknown (task %s)",
  async (state) => {
    native.state = state;
    native.processes = [
      { ProcessId: 42, CommandLine: [...native.command, WINDOWS_TASK_SUPERVISOR_FLAG].join(" ") },
    ];
    const runtime = await readScheduledTaskRuntime({});
    expect(runtime.status).toBe("unknown");
    expect(runtime.pid).toBeUndefined();
  },
);

it("does not admit stopped publication while the exact task supervisor survives on a free port", async () => {
  native.processes = [
    ...protectedProcesses,
    {
      ProcessId: 42,
      Name: "node.exe",
      CommandLine: [...native.command, WINDOWS_TASK_SUPERVISOR_FLAG].join(" "),
    },
  ];
  const runtime = await resolveFallbackRuntime(
    {},
    { programArguments: native.command },
    "control",
    performance.now() + 5_000,
  );
  expect(runtime.status).toBe("unknown");
});

it.each(
  [1, 3].flatMap((state) => [
    { state, evidence: "unavailable", snapshot: null, expected: "unknown" },
    {
      state,
      evidence: "incomplete",
      snapshot: [{ ProcessId: 42, CommandLine: null }],
      expected: "unknown",
    },
    {
      state,
      evidence: "confirmed absence",
      snapshot: [{ ProcessId: 43, CommandLine: "powershell.exe" }],
      expected: "stopped",
    },
  ]),
)(
  "keeps unreadable process evidence distinct from absence (state $state, $evidence)",
  async ({ state, snapshot, expected }) => {
    native.state = state;
    native.processes = snapshot;
    const runtime = await readScheduledTaskRuntime({});
    expect(runtime.status).toBe(expected);
    expect(runtime.state).toBe(state === 1 ? "Disabled" : "Ready");
    expect(runtime.pid).toBeUndefined();
  },
);
