import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const schtasksResponses = vi.hoisted(
  () => [] as Array<{ code: number; stdout: string; stderr: string }>,
);
const schtasksCalls = vi.hoisted(() => [] as string[][]);
const inspectPortUsage = vi.hoisted(() => vi.fn());
const killProcessTree = vi.hoisted(() => vi.fn());
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);
const taskkillCalls = vi.hoisted(() => [] as Array<{ cmd: string; args: string[] }>);
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    schtasksCalls.push(argv);
    return schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage: (...args: unknown[]) => inspectPortUsage(...args),
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTree(...args),
}));

vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (cmd: string, args?: readonly string[] | null) => spawnSyncMock(cmd, args),
  };
});

const { restartScheduledTask, resolveTaskScriptPath, stopScheduledTask } =
  await import("./schtasks.js");

function getTerminatedGatewayPids(): number[] {
  if (process.platform !== "win32") {
    return killProcessTree.mock.calls
      .map(([pid]) => pid)
      .filter((pid): pid is number => typeof pid === "number");
  }
  return taskkillCalls.flatMap(({ args }) => {
    const pidIndex = args.indexOf("/PID");
    if (pidIndex === -1) {
      return [];
    }
    const pid = Number(args[pidIndex + 1]);
    return Number.isFinite(pid) ? [pid] : [];
  });
}

function expectGatewayProcessTermination(pid: number) {
  if (process.platform === "win32") {
    expect(getTerminatedGatewayPids()).toContain(pid);
    expect(killProcessTree).not.toHaveBeenCalled();
    return;
  }
  expect(killProcessTree).toHaveBeenCalledWith(pid, { graceMs: 300 });
}

async function withWindowsEnv(
  run: (params: { tmpDir: string; env: Record<string, string> }) => Promise<void>,
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-win-stop-"));
  const env = {
    USERPROFILE: tmpDir,
    APPDATA: path.join(tmpDir, "AppData", "Roaming"),
    OPENCLAW_PROFILE: "default",
    OPENCLAW_GATEWAY_PORT: "18789",
  };
  try {
    await run({ tmpDir, env });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function writeGatewayScript(env: Record<string, string>, port = 18789) {
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

beforeEach(() => {
  schtasksResponses.length = 0;
  schtasksCalls.length = 0;
  taskkillCalls.length = 0;
  inspectPortUsage.mockReset();
  killProcessTree.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
  inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "free",
    listeners: [],
    hints: [],
  });
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((cmd: string, args?: readonly string[] | null) => {
    taskkillCalls.push({
      cmd: String(cmd),
      args: Array.isArray(args) ? args.map((arg) => String(arg)) : [],
    });
    return {
      status: 0,
      stdout: "",
      stderr: "",
      output: [],
      pid: 0,
      signal: null,
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Scheduled Task stop/restart cleanup", () => {
  it("kills lingering verified gateway listeners after schtasks stop", async () => {
    await withWindowsEnv(async ({ env }) => {
      await writeGatewayScript(env);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      );
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 4242, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValueOnce({
          port: 18789,
          status: "free",
          listeners: [],
          hints: [],
        });

      const stdout = new PassThrough();
      await stopScheduledTask({ env, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
      expectGatewayProcessTermination(4242);
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
    });
  });

  it("force-kills remaining busy port listeners when the first stop pass does not free the port", async () => {
    await withWindowsEnv(async ({ env }) => {
      await writeGatewayScript(env);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      );
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsage.mockResolvedValueOnce({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 4242, command: "node.exe" }],
        hints: [],
      });
      for (let i = 0; i < 20; i += 1) {
        inspectPortUsage.mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 4242, command: "node.exe" }],
          hints: [],
        });
      }
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 5252, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValueOnce({
          port: 18789,
          status: "free",
          listeners: [],
          hints: [],
        });

      const stdout = new PassThrough();
      await stopScheduledTask({ env, stdout });

      expect(getTerminatedGatewayPids()).toContain(4242);
      expect(getTerminatedGatewayPids().length).toBeGreaterThanOrEqual(2);
      expect(inspectPortUsage.mock.calls.length).toBeGreaterThanOrEqual(22);
    });
  });

  it("falls back to inspected gateway listeners when sync verification misses on Windows", async () => {
    await withWindowsEnv(async ({ env }) => {
      await writeGatewayScript(env);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      );
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [
            {
              pid: 6262,
              command: "node.exe",
              commandLine:
                '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
            },
          ],
          hints: [],
        })
        .mockResolvedValueOnce({
          port: 18789,
          status: "free",
          listeners: [],
          hints: [],
        });

      const stdout = new PassThrough();
      await stopScheduledTask({ env, stdout });

      expectGatewayProcessTermination(6262);
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
    });
  });

  it("kills lingering verified gateway listeners and waits for port release before restart", async () => {
    await withWindowsEnv(async ({ env }) => {
      await writeGatewayScript(env);
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      );
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5151]);
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 5151, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValueOnce({
          port: 18789,
          status: "free",
          listeners: [],
          hints: [],
        });

      const stdout = new PassThrough();
      await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
        outcome: "completed",
      });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
      expectGatewayProcessTermination(5151);
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
      expect(schtasksCalls.at(-1)).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });
});
