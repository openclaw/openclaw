import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayOwnerLeaseIdentity } from "../infra/gateway-owner-lease.js";
import {
  acquireGatewayLifecycleCoordinator,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
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
const readGatewayOwnerLease = vi.hoisted(() =>
  vi.fn<typeof import("../infra/gateway-owner-lease.js").readGatewayOwnerLease>(),
);
const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    timeState.now += ms;
  }),
);
const spawnSync = vi.hoisted(() =>
  vi.fn<
    (
      command: string,
      args?: readonly string[],
      options?: SpawnSyncOptions,
    ) => {
      pid: number;
      output: (string | null)[];
      stdout: string;
      stderr: string;
      status: number;
      signal: null;
    }
  >(),
);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync,
}));
vi.mock("../infra/gateway-owner-lease.js", () => ({ readGatewayOwnerLease }));
vi.mock("../utils.js", async (original) => ({
  ...(await original<typeof import("../utils.js")>()),
  sleep: sleepMock,
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
  await withWindowsEnv("openclaw-owner-publication-", async ({ env, tmpDir }) => {
    const scriptPath = resolveTaskScriptPath(env);
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(
      scriptPath,
      ["@echo off", INSTALLED_GATEWAY_COMMAND_LINE, ""].join("\r\n"),
      "utf8",
    );
    await withStateDatabaseCoordinatorRuntimeDirectory(path.join(tmpDir, "coordinators"), () =>
      run({ env }),
    );
  });
}
function mockWindowsTaskkillSuccess() {
  spawnSync.mockReturnValue({
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
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
  spawnSync.mockReset();
  sleepMock.mockReset().mockImplementation(async (ms) => {
    timeState.now += ms;
  });
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["snapshot", "port-only"])(
  "preserves an unattributed foreground coordinator owner before publication (%s)",
  async (discovery) => {
    await withPreparedGatewayTask(async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const foreground = acquireGatewayLifecycleCoordinator({
        databasePath: resolveOpenClawStateSqlitePath(env),
      });
      try {
        mockWindowsTaskkillSuccess();
        const foregroundCommand = INSTALLED_GATEWAY_COMMAND_LINE.replace(
          " gateway ",
          " gateway run ",
        );
        const output =
          discovery === "snapshot"
            ? JSON.stringify([{ ProcessId: 4242, CommandLine: foregroundCommand }])
            : "";
        inspectPortUsageMock.mockResolvedValue({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 4242, command: "node.exe", commandLine: foregroundCommand }],
          hints: [],
        });
        spawnSync.mockReturnValueOnce({
          pid: 0,
          output: [null, output, ""],
          stdout: output,
          stderr: "",
          status: discovery === "snapshot" ? 0 : 1,
          signal: null,
        });
        expect(readGatewayOwnerLease({ env })).toBeUndefined();

        await expect(terminateScheduledTaskGatewayListeners(env)).rejects.toThrow(
          "Gateway lifecycle ownership is held without a published identity",
        );

        expect(taskkillPids()).toEqual([]);
        expect(killProcessTreeMock).not.toHaveBeenCalled();
        expect(foreground.closed).toBe(false);
        readGatewayOwnerLease.mockReturnValue({ ...GATEWAY_OWNER, mode: "foreground" });
        await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([]);
      } finally {
        foreground.release();
      }
    });
  },
);

it.each(["snapshot", "per-pid"])(
  "terminates an installed-argv-attributed older-release coordinator holder without a row (%s)",
  async (discovery) => {
    await withPreparedGatewayTask(async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const databasePath = resolveOpenClawStateSqlitePath(env);
      const legacy = acquireGatewayLifecycleCoordinator({ databasePath });
      let forced = false;
      let firstSnapshot = true;
      inspectPortUsageMock.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [
          { pid: 4242, command: "node.exe", commandLine: INSTALLED_GATEWAY_COMMAND_LINE },
        ],
        hints: [],
      });
      spawnSync.mockImplementation((command, args) => {
        const executable = command.toLowerCase();
        if (executable.endsWith("taskkill.exe")) {
          forced = args?.includes("/F") ?? false;
          if (forced) {
            legacy.release();
          }
          return {
            pid: 0,
            output: [null, "", ""],
            stdout: "",
            stderr: "",
            status: 0,
            signal: null,
          };
        }
        if (executable.endsWith("tasklist.exe")) {
          const output = forced ? "No tasks" : '"node.exe","4242","Console","1","1 K"';
          return {
            pid: 0,
            output: [null, output, ""],
            stdout: output,
            stderr: "",
            status: 0,
            signal: null,
          };
        }
        if (firstSnapshot && discovery === "per-pid") {
          firstSnapshot = false;
          return {
            pid: 0,
            output: [null, "", ""],
            stdout: "",
            stderr: "",
            status: 1,
            signal: null,
          };
        }
        const output = JSON.stringify([
          ...(!forced ? [{ ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE }] : []),
          { ProcessId: 9999, CommandLine: "powershell.exe" },
        ]);
        return {
          pid: 0,
          output: [null, output, ""],
          stdout: output,
          stderr: "",
          status: 0,
          signal: null,
        };
      });
      try {
        await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);
        expect(taskkillPids()).toEqual([4242, 4242]);
        const successor = acquireGatewayLifecycleCoordinator({ databasePath });
        successor.release();
      } finally {
        legacy.release();
      }
    });
  },
);
