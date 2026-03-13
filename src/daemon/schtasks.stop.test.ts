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

const { restartScheduledTask, resolveTaskScriptPath, stopScheduledTask } =
  await import("./schtasks.js");

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
      expect(killProcessTree).toHaveBeenCalledWith(4242, { graceMs: 300 });
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

      expect(killProcessTree).toHaveBeenNthCalledWith(1, 4242, { graceMs: 300 });
      expect(killProcessTree).toHaveBeenNthCalledWith(2, expect.any(Number), { graceMs: 300 });
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

      expect(killProcessTree).toHaveBeenCalledWith(6262, { graceMs: 300 });
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
      expect(killProcessTree).toHaveBeenCalledWith(5151, { graceMs: 300 });
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
      expect(schtasksCalls.at(-1)).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });
});
