import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { buildTaskScript } from "../../daemon/schtasks-layout.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import type { GatewayService } from "../../daemon/service.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import * as processAncestry from "../../infra/restart-stale-pids.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  prepareStop:
    vi.fn<typeof import("../../daemon/systemd-maintenance.js").prepareSystemdGatewayMaintenance>(),
  drain: vi.fn(
    async (
      _params: Parameters<
        typeof import("./update-command-service-drain.js").withGatewayMaintenanceDrain
      >[0],
      stop: () => Promise<void>,
    ) => await stop(),
  ),
  taskState: 3 as number | string,
  taskScriptPath: "C:\\Fixture\\gateway.cmd",
  processes: [] as Array<{ ProcessId: number; CommandLine: string }>,
}));

export { mocks };
export { withServiceHome } from "./update-command-service-home.test-support.js";
export const fixtureGatewayPid = Math.max(process.pid, process.ppid) + 1;

vi.mock("../../daemon/service-process-membership.js", () => ({
  inspectServiceProcessMembershipSync: vi.fn(() => "outside"),
}));

type NativeOfflineCase = {
  platform: NodeJS.Platform;
  label: string;
  runtime: "running" | "stopped" | "unknown";
  loaded: boolean;
  offline: boolean;
  enabled?: boolean;
  phase?: "inspect" | "prepare";
  state?: number | string;
};

export const nativeOfflineCases: NativeOfflineCase[] = [
  {
    platform: "linux",
    label: "terminal inactive",
    runtime: "stopped",
    loaded: true,
    offline: true,
  },
  {
    platform: "linux",
    label: "restart transition",
    runtime: "unknown",
    loaded: true,
    offline: false,
  },
  { platform: "linux", label: "running", runtime: "running", loaded: true, offline: false },
  { platform: "darwin", label: "unloaded", runtime: "stopped", loaded: false, offline: true },
  {
    platform: "darwin",
    label: "loaded enabled",
    runtime: "stopped",
    loaded: true,
    enabled: true,
    offline: false,
  },
  {
    platform: "darwin",
    label: "loaded disabled",
    runtime: "stopped",
    loaded: true,
    enabled: false,
    offline: false,
  },
  {
    platform: "darwin",
    label: "loaded disabled preparation",
    runtime: "stopped",
    loaded: true,
    enabled: false,
    offline: false,
    phase: "prepare",
  },
  {
    platform: "darwin",
    label: "enabled unknown",
    runtime: "stopped",
    loaded: true,
    offline: false,
  },
  ...[
    { label: "disabled", state: 1, offline: true },
    { label: "ready", state: 3, offline: true },
    { label: "queued", state: 2, offline: false },
    { label: "running", state: 4, offline: false },
    { label: "unknown", state: 0, offline: false },
    { label: "malformed", state: "3 trailing output", offline: false },
  ].map<NativeOfflineCase>((task) => ({
    platform: "win32",
    runtime:
      task.state === 1 || task.state === 3 ? "stopped" : task.state === 4 ? "running" : "unknown",
    loaded: true,
    label: task.label,
    state: task.state,
    offline: task.offline,
  })),
];

vi.mock("./update-command-service-drain.js", () => ({
  withGatewayMaintenanceDrain: mocks.drain,
}));

vi.mock("../../daemon/systemd-maintenance.js", () => ({
  prepareSystemdGatewayMaintenance: mocks.prepareStop,
}));

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn((_command: string, args?: readonly string[]) => {
    const stdout = JSON.stringify(
      args?.some((arg) => arg.includes("Get-CimInstance Win32_Process"))
        ? mocks.processes
        : {
            taskPath: "\\OpenClaw Gateway",
            state: mocks.taskState,
            lastRunResult: 0,
            actions: [{ type: 0, path: mocks.taskScriptPath, arguments: "", workingDirectory: "" }],
          },
    );
    return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
  }),
}));

beforeEach(() => {
  mockSystemAccountHome();
  mocks.processes = [];
  // Simulated service platforms must not read the host's native ancestry.
  vi.spyOn(processAncestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
    pids: new Set([process.pid, process.ppid, 1]),
    complete: true,
  });
  mocks.prepareStop.mockReset().mockResolvedValue(false);
  mocks.drain.mockReset().mockImplementation(async (_params, stop) => await stop());
});
afterEach(() => vi.restoreAllMocks());

export function mockRegisteredWindowsLauncher(
  home: string,
  running = false,
): GatewayServiceCommandConfig {
  const command = {
    programArguments: [
      process.execPath,
      path.join(process.cwd(), "openclaw.mjs"),
      "gateway",
      "--port",
      "18789",
    ],
    environment: { HOME: home },
    sourcePath: mocks.taskScriptPath,
  };
  mocks.processes = [
    { ProcessId: 111, CommandLine: "powershell.exe Get-CimInstance Win32_Process" },
    ...(running
      ? [
          {
            ProcessId: fixtureGatewayPid,
            CommandLine: command.programArguments.map((arg) => `"${arg}"`).join(" "),
          },
        ]
      : []),
  ];
  const script = Buffer.from(buildTaskScript(command));
  const readFile = fs.readFile;
  vi.spyOn(fs, "readFile").mockImplementation(async (pathname, options) =>
    pathname === mocks.taskScriptPath ? script : readFile(pathname, options),
  );
  return command;
}
