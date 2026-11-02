import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import type { GatewayOwnerLeaseIdentity } from "../infra/gateway-owner-lease.types.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as bootReader from "../infra/update-managed-service-handoff-boot.js";
import * as pidAlive from "../shared/pid-alive.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveTaskScriptPath } from "./schtasks-layout.js";
import "./test-helpers/schtasks-base-mocks.js";
import {
  inspectPortUsageMock,
  killProcessTreeMock,
  resetSchtasksBaseMocks,
  withWindowsEnv,
} from "./test-helpers/schtasks-fixtures.js";

const timeState = vi.hoisted(() => ({ now: 0 }));
const readWindowsProcessStartTime = vi.hoisted(() =>
  vi.fn<typeof import("../infra/windows-process-start.js").readWindowsProcessStartTimeSync>(),
);
const readGatewayOwnerLease = vi.hoisted(() =>
  vi.fn<typeof import("../infra/gateway-owner-lease.js").readGatewayOwnerLease>(),
);
const spawnSync = vi.hoisted(() =>
  vi.fn<
    (
      command: string,
      args?: readonly string[],
      options?: SpawnSyncOptions,
    ) => ReturnType<typeof nativeResult>
  >(),
);
function nativeResult(stdout = "", status = 0) {
  return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status, signal: null };
}
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync,
}));
vi.mock("../infra/gateway-owner-lease.js", () => ({ readGatewayOwnerLease }));
vi.mock("../infra/windows-process-start.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/windows-process-start.js")>()),
  readWindowsProcessStartTimeSync: readWindowsProcessStartTime,
}));
vi.mock("../utils.js", async (original) => ({
  ...(await original<typeof import("../utils.js")>()),
  sleep: async (ms: number) => {
    timeState.now += ms;
  },
}));
const { terminateScheduledTaskGatewayListeners } = await import("./schtasks-process.js");
const INSTALLED_GATEWAY_COMMAND_LINE =
  '"C:\\node\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789';
const GATEWAY_OWNER: GatewayOwnerLeaseIdentity = {
  owner: "published-owner",
  pid: 4242,
  host: "fixture-host",
  startedAt: 100,
  port: 18789,
  mode: "foreground",
  supervisor: null,
  state: "live",
  expired: false,
};

async function withPreparedGatewayTask(
  run: (params: { env: Record<string, string> }) => Promise<void>,
) {
  await withWindowsEnv("openclaw-owner-publication-", async ({ env }) => {
    const scriptPath = resolveTaskScriptPath(env);
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, `@echo off\r\n${INSTALLED_GATEWAY_COMMAND_LINE}\r\n`, "utf8");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await run({ env });
  });
}
function busyGateway(commandLine: string) {
  inspectPortUsageMock.mockResolvedValue({
    port: 18789,
    status: "busy",
    listeners: [{ pid: 4242, command: "node.exe", commandLine }],
    hints: [],
  });
}
function taskkillPids() {
  return spawnSync.mock.calls
    .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
    .map(([, args]) => Number(args?.[args.indexOf("/PID") + 1]));
}
beforeEach(() => {
  resetSchtasksBaseMocks();
  readGatewayOwnerLease.mockReset();
  readWindowsProcessStartTime.mockReset().mockReturnValue(null);
  spawnSync.mockReset();
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
    platform: "win32",
    identity: "2026-10-19T00:00:00.0000000Z",
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["snapshot", "port-only"])(
  "preserves an unattributed foreground coordinator owner before publication (%s)",
  async (discovery) => {
    await withPreparedGatewayTask(async ({ env }) => {
      spawnSync.mockReturnValue(nativeResult());
      const foreground = acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(env),
      });
      try {
        const foregroundCommand = INSTALLED_GATEWAY_COMMAND_LINE.replace(
          " gateway ",
          " gateway run ",
        );
        const output =
          discovery === "snapshot"
            ? JSON.stringify([{ ProcessId: 4242, CommandLine: foregroundCommand }])
            : "";
        busyGateway(foregroundCommand);
        spawnSync.mockReturnValueOnce(nativeResult(output, discovery === "snapshot" ? 0 : 1));
        expect(readGatewayOwnerLease({ env })).toBeUndefined();

        await expect(terminateScheduledTaskGatewayListeners(env)).rejects.toThrow(
          "Gateway lifecycle ownership is held without a published identity",
        );

        expect(taskkillPids()).toEqual([]);
        expect(killProcessTreeMock).not.toHaveBeenCalled();
        expect(() => foreground.assertCurrent()).not.toThrow();
        readGatewayOwnerLease.mockReturnValue({ ...GATEWAY_OWNER, mode: "foreground" });
        await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([]);
      } finally {
        foreground.release();
      }
    });
  },
);

it.each(["snapshot", "per-pid", "overdue"])(
  "terminates an attributed unpublished coordinator holder (%s)",
  async (discovery) => {
    await withPreparedGatewayTask(async ({ env }) => {
      spawnSync.mockReturnValue(nativeResult());
      const databasePath = resolveOpenClawStateSqlitePath(env);
      const overdue = discovery === "overdue";
      let forced = false;
      if (overdue) {
        vi.spyOn(pidAlive, "isPidAlive").mockImplementation((pid) => pid === 4242 && !forced);
        readWindowsProcessStartTime.mockReturnValue(100);
        inspectPortUsageMock.mockResolvedValue({
          port: 18789,
          status: "free",
          listeners: [],
          hints: [],
        });
      } else {
        busyGateway(INSTALLED_GATEWAY_COMMAND_LINE);
      }
      const custody = acquireGatewayStateOwner({
        databasePath,
        payload: overdue
          ? {
              pid: 4242,
              startTime: 100,
              processNamespace: readGatewayLockProcessNamespace(),
              ownerId: "stuck-startup",
              role: "gateway",
              createdAt: new Date(-300_001).toISOString(),
              configPath: "fixture-config",
            }
          : undefined,
      });
      if (!overdue) {
        readWindowsProcessStartTime.mockImplementation(() =>
          forced ? null : Date.parse("2026-09-27T00:00:00.000Z"),
        );
      }
      let firstSnapshot = true;
      spawnSync.mockImplementation((command, args) => {
        const executable = command.toLowerCase();
        if (executable.endsWith("taskkill.exe")) {
          forced = args?.includes("/F") ?? false;
          if (forced) {
            custody.release();
          }
          return nativeResult();
        }
        if (executable.endsWith("tasklist.exe")) {
          const output = forced ? "No tasks" : '"node.exe","4242","Console","1","1 K"';
          return nativeResult(output);
        }
        if (firstSnapshot && discovery === "per-pid") {
          firstSnapshot = false;
          return nativeResult("", 1);
        }
        if (overdue) {
          return nativeResult("[]");
        }
        const output = JSON.stringify([
          ...(!forced ? [{ ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE }] : []),
          { ProcessId: 9999, CommandLine: "powershell.exe" },
        ]);
        return nativeResult(output);
      });
      try {
        await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);
        expect(taskkillPids()).toEqual([4242, 4242]);
        const successor = acquireGatewayStateOwner({ databasePath });
        successor.release();
      } finally {
        custody.release();
      }
    });
  },
);
