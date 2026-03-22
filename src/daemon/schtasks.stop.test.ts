import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/schtasks-base-mocks.js";
import { resolveTaskScriptPath } from "./schtasks.js";
import {
  inspectPortUsage,
  killProcessTree,
  resetSchtasksBaseMocks,
  schtasksCalls,
  schtasksResponses,
  withWindowsEnv,
  writeGatewayConfig,
  writeGatewayScript,
} from "./test-helpers/schtasks-fixtures.js";
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);
const timeState = vi.hoisted(() => ({ now: 0 }));
const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    timeState.now += ms;
  }),
);

vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
}));
vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleepMock(ms),
  };
});

const { restartScheduledTask, stopScheduledTask } = await import("./schtasks.js");
const GATEWAY_PORT = 18789;
const SUCCESS_RESPONSE = { code: 0, stdout: "", stderr: "" } as const;

function pushSuccessfulSchtasksResponses(count: number) {
  for (let i = 0; i < count; i += 1) {
    schtasksResponses.push({ ...SUCCESS_RESPONSE });
  }
}

function freePortUsage() {
  return {
    port: GATEWAY_PORT,
    status: "free" as const,
    listeners: [],
    hints: [],
  };
}

function busyPortUsage(
  pid: number,
  options: {
    command?: string;
    commandLine?: string;
  } = {},
) {
  return {
    port: GATEWAY_PORT,
    status: "busy" as const,
    listeners: [
      {
        pid,
        command: options.command ?? "node.exe",
        ...(options.commandLine ? { commandLine: options.commandLine } : {}),
      },
    ],
    hints: [],
  };
}

function expectGatewayTermination(pid: number) {
  if (process.platform === "win32") {
    expect(killProcessTree).not.toHaveBeenCalled();
    return;
  }
  expect(killProcessTree).toHaveBeenCalledWith(pid, { graceMs: 300 });
}

async function withPreparedGatewayTask(
  run: (context: { env: Record<string, string>; stdout: PassThrough }) => Promise<void>,
) {
  await withWindowsEnv("openclaw-win-stop-", async ({ env }) => {
    await writeGatewayScript(env, GATEWAY_PORT);
    const stdout = new PassThrough();
    await run({ env, stdout });
  });
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
  });
  inspectPortUsage.mockResolvedValue(freePortUsage());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Scheduled Task stop/restart cleanup", () => {
  it("kills lingering verified gateway listeners after schtasks stop", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(4242))
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(4242);
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
    });
  });

  it("force-kills remaining busy port listeners when the first stop pass does not free the port", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsage.mockResolvedValueOnce(busyPortUsage(4242));
      for (let i = 0; i < 20; i += 1) {
        inspectPortUsage.mockResolvedValueOnce(busyPortUsage(4242));
      }
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(5252))
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env, stdout });

      if (process.platform !== "win32") {
        expect(killProcessTree).toHaveBeenNthCalledWith(1, 4242, { graceMs: 300 });
        expect(killProcessTree).toHaveBeenNthCalledWith(2, expect.any(Number), { graceMs: 300 });
      } else {
        expect(killProcessTree).not.toHaveBeenCalled();
      }
      expect(inspectPortUsage.mock.calls.length).toBeGreaterThanOrEqual(22);
    });
  });

  it("falls back to inspected gateway listeners when sync verification misses on Windows", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
      inspectPortUsage
        .mockResolvedValueOnce(
          busyPortUsage(6262, {
            commandLine:
              '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
          }),
        )
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env, stdout });

      expectGatewayTermination(6262);
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
    });
  });

  it("kills lingering verified gateway listeners and waits for port release before restart", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(4);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5151]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(5151))
        .mockResolvedValueOnce(freePortUsage());

      await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
        outcome: "completed",
      });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(5151);
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
      expect(schtasksCalls.at(-1)).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

  it("resolves the stop port from config when the task script omits both --port and OPENCLAW_GATEWAY_PORT", async () => {
    await withWindowsEnv("openclaw-win-stop-", async ({ env }) => {
      await writeGatewayScript(env, GATEWAY_PORT, {
        includePortEnv: false,
        includePortFlag: false,
      });
      await writeGatewayConfig(env, GATEWAY_PORT);
      const stdout = new PassThrough();
      const envWithoutPort = { ...env };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4343]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(4343))
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env: envWithoutPort, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(4343);
    });
  });

  it("resolves the restart port from config when the task script omits both --port and OPENCLAW_GATEWAY_PORT", async () => {
    await withWindowsEnv("openclaw-win-stop-", async ({ env }) => {
      await writeGatewayScript(env, GATEWAY_PORT, {
        includePortEnv: false,
        includePortFlag: false,
      });
      await writeGatewayConfig(env, GATEWAY_PORT);
      const stdout = new PassThrough();
      const envWithoutPort = { ...env };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      pushSuccessfulSchtasksResponses(4);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5454]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(5454))
        .mockResolvedValueOnce(freePortUsage());

      await expect(restartScheduledTask({ env: envWithoutPort, stdout })).resolves.toEqual({
        outcome: "completed",
      });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(5454);
      expect(schtasksCalls.at(-1)).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

  it("prefers the task env config over the caller shell env when OPENCLAW_STATE_DIR differs", async () => {
    await withWindowsEnv("openclaw-win-stop-", async ({ env, tmpDir }) => {
      const taskEnv = { ...env, OPENCLAW_STATE_DIR: path.join(tmpDir, "task-state") };
      const shellEnv = {
        ...env,
        OPENCLAW_STATE_DIR: path.join(tmpDir, "shell-state"),
        OPENCLAW_TASK_SCRIPT: resolveTaskScriptPath(taskEnv),
      };
      await writeGatewayScript(taskEnv, GATEWAY_PORT, {
        includePortEnv: false,
        includePortFlag: false,
        extraEnv: { OPENCLAW_STATE_DIR: taskEnv.OPENCLAW_STATE_DIR },
      });
      await writeGatewayConfig(taskEnv, GATEWAY_PORT);
      await writeGatewayConfig(shellEnv, 29999);
      const stdout = new PassThrough();
      const envWithoutPort: Record<string, string> = { ...shellEnv };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([6464]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(6464))
        .mockResolvedValueOnce(freePortUsage());
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = shellEnv.OPENCLAW_STATE_DIR;

      try {
        await stopScheduledTask({ env: envWithoutPort, stdout });
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(6464);
    });
  });

  it("ignores legacy shell gateway port vars once fallback reads the task config", async () => {
    await withWindowsEnv("openclaw-win-stop-", async ({ env, tmpDir }) => {
      const taskEnv = { ...env, OPENCLAW_STATE_DIR: path.join(tmpDir, "task-state") };
      const shellEnv = {
        ...env,
        OPENCLAW_STATE_DIR: path.join(tmpDir, "shell-state"),
        OPENCLAW_TASK_SCRIPT: resolveTaskScriptPath(taskEnv),
        CLAWDBOT_GATEWAY_PORT: "29999",
      };
      await writeGatewayScript(taskEnv, GATEWAY_PORT, {
        includePortEnv: false,
        includePortFlag: false,
        extraEnv: { OPENCLAW_STATE_DIR: taskEnv.OPENCLAW_STATE_DIR },
      });
      await writeGatewayConfig(taskEnv, GATEWAY_PORT);
      await writeGatewayConfig(shellEnv, 29999);
      const stdout = new PassThrough();
      const envWithoutPort: Record<string, string> = { ...shellEnv };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([7373]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(7373))
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env: envWithoutPort, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(7373);
    });
  });

  it("uses OPENCLAW_HOME from the task env when config fallback resolves the port", async () => {
    await withWindowsEnv("openclaw-win-stop-", async ({ env, tmpDir }) => {
      const taskHome = path.join(tmpDir, "task-home");
      const shellHome = path.join(tmpDir, "shell-home");
      const taskEnv = { ...env, OPENCLAW_HOME: taskHome };
      const shellEnv = {
        ...env,
        OPENCLAW_HOME: shellHome,
        OPENCLAW_TASK_SCRIPT: resolveTaskScriptPath(taskEnv),
      };
      await writeGatewayScript(taskEnv, GATEWAY_PORT, {
        includePortEnv: false,
        includePortFlag: false,
        extraEnv: { OPENCLAW_HOME: taskEnv.OPENCLAW_HOME },
      });
      await writeGatewayConfig(taskEnv, GATEWAY_PORT);
      await writeGatewayConfig(shellEnv, 29999);
      const stdout = new PassThrough();
      const envWithoutPort: Record<string, string> = { ...shellEnv };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([8484]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(8484))
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env: envWithoutPort, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(8484);
    });
  });

  it("ignores shell OPENCLAW_CONFIG_PATH once the task env provides its own config root", async () => {
    await withWindowsEnv("openclaw-win-stop-", async ({ env, tmpDir }) => {
      const taskEnv = { ...env, OPENCLAW_STATE_DIR: path.join(tmpDir, "task-state") };
      const shellEnvBase = {
        ...env,
        OPENCLAW_STATE_DIR: path.join(tmpDir, "shell-state"),
        OPENCLAW_TASK_SCRIPT: resolveTaskScriptPath(taskEnv),
      };
      await writeGatewayScript(taskEnv, GATEWAY_PORT, {
        includePortEnv: false,
        includePortFlag: false,
        extraEnv: { OPENCLAW_STATE_DIR: taskEnv.OPENCLAW_STATE_DIR },
      });
      await writeGatewayConfig(taskEnv, GATEWAY_PORT);
      const shellConfigPath = await writeGatewayConfig(shellEnvBase, 29999);
      const shellEnv = { ...shellEnvBase, OPENCLAW_CONFIG_PATH: shellConfigPath };
      const stdout = new PassThrough();
      const envWithoutPort: Record<string, string> = { ...shellEnv };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([9595]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(9595))
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env: envWithoutPort, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(9595);
    });
  });

  it("discovers legacy default state-dir configs when the task omits explicit port settings", async () => {
    await withWindowsEnv("openclaw-win-stop-", async ({ env, tmpDir }) => {
      const legacyStateDir = path.join(tmpDir, ".clawdbot");
      const shellEnv = {
        ...env,
        OPENCLAW_TASK_SCRIPT: path.join(legacyStateDir, "gateway.cmd"),
      };
      await writeGatewayScript(shellEnv, GATEWAY_PORT, {
        includePortEnv: false,
        includePortFlag: false,
      });
      await fs.mkdir(legacyStateDir, { recursive: true });
      await fs.writeFile(
        path.join(legacyStateDir, "clawdbot.json"),
        JSON.stringify(
          {
            gateway: {
              port: GATEWAY_PORT,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const stdout = new PassThrough();
      const envWithoutPort: Record<string, string> = { ...shellEnv };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([9696]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(9696))
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env: envWithoutPort, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(9696);
    });
  });

  it("does not let config.env mutate the caller env during fallback port discovery", async () => {
    await withWindowsEnv("openclaw-win-stop-", async ({ env, tmpDir }) => {
      const taskState = path.join(tmpDir, "task-state");
      const wrongState = path.join(tmpDir, "wrong-state");
      const taskEnv = { ...env, OPENCLAW_STATE_DIR: taskState };
      const wrongEnv = { ...env, OPENCLAW_STATE_DIR: wrongState, OPENCLAW_GATEWAY_PORT: "29999" };
      const callerEnv: Record<string, string> = {
        ...env,
        OPENCLAW_STATE_DIR: taskState,
        OPENCLAW_TASK_SCRIPT: resolveTaskScriptPath(taskEnv),
      };
      const startupEntryPath = path.join(
        env.APPDATA,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "OpenClaw Gateway.cmd",
      );

      await writeGatewayScript(taskEnv, GATEWAY_PORT, {
        includePortEnv: false,
        includePortFlag: false,
      });
      await writeGatewayScript(wrongEnv, 29999, {
        includePortEnv: true,
        includePortFlag: true,
      });
      await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
      await fs.writeFile(startupEntryPath, "@echo off\r\n", "utf8");
      await fs.mkdir(taskState, { recursive: true });
      await fs.writeFile(
        path.join(taskState, "openclaw.json"),
        JSON.stringify(
          {
            gateway: { port: GATEWAY_PORT },
            env: {
              vars: {
                OPENCLAW_TASK_SCRIPT: resolveTaskScriptPath(wrongEnv),
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const stdout = new PassThrough();
      delete callerEnv.OPENCLAW_GATEWAY_PORT;
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([9797]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(9797))
        .mockResolvedValueOnce(freePortUsage())
        .mockResolvedValueOnce(freePortUsage())
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env: callerEnv, stdout });

      expect(callerEnv.OPENCLAW_TASK_SCRIPT).toBe(resolveTaskScriptPath(taskEnv));
      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expect(inspectPortUsage).not.toHaveBeenCalledWith(29999);
      expectGatewayTermination(9797);
    });
  });
});
