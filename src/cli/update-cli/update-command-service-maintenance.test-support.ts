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

vi.mock("../../daemon/service-process-membership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service-process-membership.js")>()),
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
const offlineRows: [NodeJS.Platform, string, Partial<NativeOfflineCase>][] = [
  ["linux", "terminal inactive", { offline: true }],
  ["linux", "restart transition", { runtime: "unknown" }],
  ["linux", "running", { runtime: "running" }],
  ["darwin", "unloaded", { loaded: false, offline: true }],
  ["darwin", "loaded enabled", { enabled: true }],
  ["darwin", "loaded disabled", { enabled: false }],
  ["darwin", "loaded disabled preparation", { enabled: false, phase: "prepare" }],
  ["darwin", "enabled unknown", {}],
  ["win32", "disabled", { state: 1, offline: true }],
  ["win32", "ready", { state: 3, offline: true }],
  ["win32", "queued", { state: 2, runtime: "unknown" }],
  ["win32", "running", { state: 4, runtime: "running" }],
  ["win32", "unknown", { state: 0, runtime: "unknown" }],
  ["win32", "malformed", { state: "3 trailing output", runtime: "unknown" }],
];
export const nativeOfflineCases = offlineRows.map(
  ([platform, label, overrides]): NativeOfflineCase =>
    Object.assign(
      { platform, label, runtime: "stopped" as const, loaded: true, offline: false },
      overrides,
    ),
);

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
  mocks.prepareStop.mockReset().mockResolvedValue({ kind: "unchanged" });
  mocks.drain.mockReset().mockImplementation(async (_params, stop) => await stop());
});
afterEach(() => vi.restoreAllMocks());

export function mockRegisteredWindowsLauncher(
  home: string,
  running = false,
): GatewayServiceCommandConfig {
  const entrypoint = path.join(process.cwd(), "openclaw.mjs");
  const command = {
    programArguments: [process.execPath, entrypoint, "gateway", "--port", "18789"],
    environment: { HOME: home },
    sourcePath: mocks.taskScriptPath,
  };
  mocks.processes = [
    { ProcessId: 111, CommandLine: "powershell.exe Get-CimInstance Win32_Process" },
  ];
  if (running) {
    mocks.processes.push({
      ProcessId: fixtureGatewayPid,
      CommandLine: command.programArguments.map((arg) => `"${arg}"`).join(" "),
    });
  }
  const script = Buffer.from(buildTaskScript(command));
  const readFile = fs.readFile;
  vi.spyOn(fs, "readFile").mockImplementation(async (pathname, options) =>
    pathname === mocks.taskScriptPath ? script : readFile(pathname, options),
  );
  return command;
}
