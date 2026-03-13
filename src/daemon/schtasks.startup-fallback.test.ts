import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quoteCmdScriptArg } from "./cmd-argv.js";

const schtasksResponses = vi.hoisted(
  () => [] as Array<{ code: number; stdout: string; stderr: string }>,
);
const schtasksCalls = vi.hoisted(() => [] as string[][]);
const inspectPortUsage = vi.hoisted(() => vi.fn());
const killProcessTree = vi.hoisted(() => vi.fn());
const childUnref = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn(() => ({ unref: childUnref })));

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

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn,
  };
});

const {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskRuntime,
  restartScheduledTask,
  resolveTaskScriptPath,
} = await import("./schtasks.js");

function resolveStartupEntryPath(env: Record<string, string>) {
  return path.join(
    env.APPDATA,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "OpenClaw Gateway.cmd",
  );
}

async function withWindowsEnv(
  run: (params: { tmpDir: string; env: Record<string, string> }) => Promise<void>,
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-win-startup-"));
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

beforeEach(() => {
  schtasksResponses.length = 0;
  schtasksCalls.length = 0;
  inspectPortUsage.mockReset();
  killProcessTree.mockReset();
  spawn.mockClear();
  childUnref.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Windows startup fallback", () => {
  it("falls back to a Startup-folder launcher when schtasks create is denied", async () => {
    await withWindowsEnv(async ({ env }) => {
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 5, stdout: "", stderr: "ERROR: Access is denied." },
      );

      const stdout = new PassThrough();
      let printed = "";
      stdout.on("data", (chunk) => {
        printed += String(chunk);
      });

      const result = await installScheduledTask({
        env,
        stdout,
        programArguments: ["node", "gateway.js", "--port", "18789"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      const startupEntryPath = resolveStartupEntryPath(env);
      const startupScript = await fs.readFile(startupEntryPath, "utf8");
      expect(result.scriptPath).toBe(resolveTaskScriptPath(env));
      expect(startupScript).toContain('start "" /min cmd.exe /d /c');
      expect(startupScript).toContain("gateway.cmd");
      expect(spawn).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", quoteCmdScriptArg(resolveTaskScriptPath(env))],
        expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
      );
      expect(childUnref).toHaveBeenCalled();
      expect(printed).toContain("Installed Windows login item");
    });
  });

  it("falls back to a Startup-folder launcher when schtasks create hangs", async () => {
    await withWindowsEnv(async ({ env }) => {
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
      );

      const stdout = new PassThrough();
      await installScheduledTask({
        env,
        stdout,
        programArguments: ["node", "gateway.js", "--port", "18789"],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      await expect(fs.access(resolveStartupEntryPath(env))).resolves.toBeUndefined();
      expect(spawn).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", quoteCmdScriptArg(resolveTaskScriptPath(env))],
        expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
      );
    });
  });

  it("treats an installed Startup-folder launcher as loaded", async () => {
    await withWindowsEnv(async ({ env }) => {
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
      );
      await fs.mkdir(path.dirname(resolveStartupEntryPath(env)), { recursive: true });
      await fs.writeFile(resolveStartupEntryPath(env), "@echo off\r\n", "utf8");

      await expect(isScheduledTaskInstalled({ env })).resolves.toBe(true);
    });
  });

  it("reports runtime from the gateway listener when using the Startup fallback", async () => {
    await withWindowsEnv(async ({ env }) => {
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
      );
      await fs.mkdir(path.dirname(resolveStartupEntryPath(env)), { recursive: true });
      await fs.writeFile(resolveStartupEntryPath(env), "@echo off\r\n", "utf8");
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 4242, command: "node.exe" }],
        hints: [],
      });

      await expect(readScheduledTaskRuntime(env)).resolves.toMatchObject({
        status: "running",
        pid: 4242,
      });
    });
  });

  it("restarts the Startup fallback by killing the current pid and relaunching the entry", async () => {
    await withWindowsEnv(async ({ env }) => {
      schtasksResponses.push(
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
      );
      await fs.mkdir(path.dirname(resolveStartupEntryPath(env)), { recursive: true });
      await fs.writeFile(resolveStartupEntryPath(env), "@echo off\r\n", "utf8");
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 5151, command: "node.exe" }],
        hints: [],
      });

      const stdout = new PassThrough();
      await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
        outcome: "completed",
      });
      expect(killProcessTree).toHaveBeenCalledWith(5151, { graceMs: 300 });
      expect(spawn).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", quoteCmdScriptArg(resolveTaskScriptPath(env))],
        expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
      );
    });
  });
});
