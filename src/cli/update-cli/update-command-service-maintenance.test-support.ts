import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { buildTaskScript } from "../../daemon/schtasks-layout.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import type { GatewayService } from "../../daemon/service.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import * as processAncestry from "../../infra/restart-stale-pids.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { withEnvAsync } from "../../test-utils/env.js";

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
}));

export { mocks };
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
  spawnSync: vi.fn(() => ({
    pid: 0,
    output: [null, JSON.stringify({ state: mocks.taskState, lastRunResult: 0 }), ""],
    stdout: JSON.stringify({
      taskPath: "\\OpenClaw Gateway",
      state: mocks.taskState,
      lastRunResult: 0,
      actions: [{ type: 0, path: mocks.taskScriptPath, arguments: "", workingDirectory: "" }],
    }),
    stderr: "",
    status: 0,
    signal: null,
  })),
}));

beforeEach(() => {
  mockSystemAccountHome();
  // Simulated service platforms must not read the host's native ancestry.
  vi.spyOn(processAncestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
    pids: new Set([process.pid, process.ppid, 1]),
    complete: true,
  });
  mocks.prepareStop.mockReset().mockResolvedValue(false);
  mocks.drain.mockReset().mockImplementation(async (_params, stop) => await stop());
});
afterEach(() => vi.restoreAllMocks());

export function mockRegisteredWindowsLauncher(home: string): GatewayServiceCommandConfig {
  const command = {
    programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
    environment: { HOME: home },
    sourcePath: mocks.taskScriptPath,
  };
  const script = Buffer.from(buildTaskScript(command));
  const readFile = fs.readFile;
  vi.spyOn(fs, "readFile").mockImplementation(async (pathname, options) =>
    pathname === mocks.taskScriptPath ? script : readFile(pathname, options),
  );
  return command;
}

export async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.realpath(await makeTempWorkspace("openclaw-update-service-"));
  const tempRoot = vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  try {
    // Verify the actual resolver and its filesystem alias before any helper opens SQLite.
    const databasePath = resolveManagedUpdateLeaseDatabasePath();
    expect(databasePath).toBe(path.join(home, "managed-update-handoffs.sqlite"));
    expect(await fs.realpath(path.dirname(databasePath))).toBe(home);
    await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData"),
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
      },
      () => run(home),
    );
  } finally {
    tempRoot.mockRestore();
    await fs.rm(home, { recursive: true, force: true });
  }
}
