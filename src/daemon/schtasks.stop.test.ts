import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/schtasks-base-mocks.js";
import {
  inspectPortUsage,
  killProcessTree,
  resetSchtasksBaseMocks,
  schtasksCalls,
  schtasksResponses,
  withWindowsEnv,
} from "./test-helpers/schtasks-fixtures.js";
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);

vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
}));

const { restartScheduledTask, resolveTaskScriptPath, stopScheduledTask } =
  await import("./schtasks.js");
const GATEWAY_PORT = 18789;
const SUCCESS_RESPONSE = { code: 0, stdout: "", stderr: "" } as const;

async function writeGatewayScript(env: Record<string, string>, port = GATEWAY_PORT) {
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(
    scriptPath,
    [
      "@echo off",
      `set "OPENCLAW_GATEWAY_PORT=${port}"`,
      `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port ${port}`,
      "",
    ].join("\r\n"),
    "utf8",
  );
}

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

async function withPreparedGatewayTask(
  run: (context: { env: Record<string, string>; stdout: PassThrough }) => Promise<void>,
) {
  await withWindowsEnv("openclaw-win-stop-", async ({ env }) => {
    await writeGatewayScript(env);
    const stdout = new PassThrough();
    await run({ env, stdout });
  });
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
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
      expect(killProcessTree).toHaveBeenCalledWith(4242, { graceMs: 300 });
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

      expect(killProcessTree).toHaveBeenNthCalledWith(1, 4242, { graceMs: 300 });
      expect(killProcessTree).toHaveBeenNthCalledWith(2, expect.any(Number), { graceMs: 300 });
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

      expect(killProcessTree).toHaveBeenCalledWith(6262, { graceMs: 300 });
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
      expect(killProcessTree).toHaveBeenCalledWith(5151, { graceMs: 300 });
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
      expect(schtasksCalls.at(-1)).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });
});
