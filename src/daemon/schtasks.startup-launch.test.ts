// Startup launcher spawn admission is independent of Scheduled Task takeover.
import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
} from "../infra/windows-install-roots.js";
import "./test-helpers/schtasks-base-mocks.js";
import { resolveTaskScriptPath } from "./schtasks-layout.js";
import { launchFallbackTaskScript } from "./schtasks-runtime.js";
import {
  createSpawnChild,
  makeSpawnSyncResult,
  resetSchtasksBaseMocks,
  withWindowsEnv,
  writeGatewayScript,
  type SpawnSyncResult,
} from "./test-helpers/schtasks-fixtures.js";

const childUnref = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn());
const spawnSync = vi.hoisted(() =>
  vi.fn<
    (command: string, args?: readonly string[], options?: SpawnSyncOptions) => SpawnSyncResult
  >(),
);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
  spawnSync,
}));
beforeEach(() => {
  resetSchtasksBaseMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  childUnref.mockReset();
  spawn.mockReset().mockImplementation(() => createSpawnChild(childUnref));
  spawnSync.mockReset().mockImplementation(() => makeSpawnSyncResult());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Windows Startup launcher", () => {
  it("rejects asynchronous direct executable spawn failures without detaching", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      await writeGatewayScript(env);
      const error = Object.assign(new Error("spawn direct ENOENT"), { code: "ENOENT" });
      spawn.mockImplementationOnce(() => createSpawnChild(childUnref, error));

      await expect(launchFallbackTaskScript(env)).rejects.toThrow("spawn direct ENOENT");
      expect(childUnref).not.toHaveBeenCalled();
    });
  });

  it("rejects asynchronous cmd fallback spawn failures without detaching", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const scriptPath = resolveTaskScriptPath(env);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(scriptPath, "@echo off\r\nrem no parsed command\r\n", "utf8");
      const error = Object.assign(new Error("spawn cmd ENOENT"), { code: "ENOENT" });
      spawn.mockImplementationOnce(() => createSpawnChild(childUnref, error));

      await expect(launchFallbackTaskScript(env)).rejects.toThrow("spawn cmd ENOENT");
      expect(childUnref).not.toHaveBeenCalled();
    });
  });

  it("rejects a missing cmd fallback script before starting cmd", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      await expect(launchFallbackTaskScript(env)).rejects.toThrow(/ENOENT|no such file/i);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("rejects an ACL-denied cmd fallback script before starting cmd", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      const scriptPath = resolveTaskScriptPath(env);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(scriptPath, "@echo off\r\n", "utf8");
      const denied = Object.assign(new Error("open fallback script EACCES"), { code: "EACCES" });
      vi.spyOn(fs, "open").mockRejectedValueOnce(denied);

      await expect(launchFallbackTaskScript(env, null)).rejects.toThrow(
        "open fallback script EACCES",
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(childUnref).not.toHaveBeenCalled();
    });
  });

  it("rejects denied cmd script access even when Node opens it with backup privileges", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env, tmpDir }) => {
      env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state & %USERPROFILE%");
      const scriptPath = resolveTaskScriptPath(env);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(scriptPath, "@echo off\r\n", "utf8");
      spawnSync.mockReturnValueOnce(makeSpawnSyncResult({ status: 1 }));

      await expect(launchFallbackTaskScript(env, null)).rejects.toMatchObject({ code: "EACCES" });
      expect(spawnSync).toHaveBeenCalledWith(
        getWindowsPowerShellExePath(),
        expect.arrayContaining(["-EncodedCommand"]),
        expect.objectContaining({
          env: expect.objectContaining({ OPENCLAW_TASK_SCRIPT: scriptPath }),
          stdio: "ignore",
          windowsHide: true,
        }),
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(childUnref).not.toHaveBeenCalled();
    });
  });

  it("detaches the direct executable only after it starts", async () => {
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      await writeGatewayScript(env);

      await expect(launchFallbackTaskScript(env)).resolves.toBeUndefined();
      expect(spawn).toHaveBeenCalledWith(
        "C:\\Program Files\\nodejs\\node.exe",
        expect.arrayContaining(["gateway", "--port", "18789"]),
        expect.objectContaining({
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: expect.objectContaining({
            BOUNDARY_PARENT_ONLY: "synthetic",
            OPENCLAW_GATEWAY_PORT: "18789",
          }),
        }),
      );
      expect(childUnref).toHaveBeenCalledOnce();
    });
  });

  it("keeps Gateway fallback execution inside the task supervisor", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      await expect(
        launchFallbackTaskScript(env, {
          programArguments: ["C:\\Program Files\\nodejs\\node.exe", "gateway.js"],
          environment: { OPENCLAW_SERVICE_KIND: "gateway" },
        }),
      ).resolves.toBeUndefined();

      expect(spawn).toHaveBeenCalledWith(
        "C:\\Program Files\\nodejs\\node.exe",
        ["gateway.js", "--task-supervisor"],
        expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
      );
    });
  });

  it("detaches the cmd fallback only after it starts", async () => {
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    await withWindowsEnv("openclaw-win-startup-", async ({ env, tmpDir }) => {
      env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state & %USERPROFILE% !");
      const scriptPath = resolveTaskScriptPath(env);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(scriptPath, "@echo off\r\nrem no parsed command\r\n", "utf8");

      await expect(launchFallbackTaskScript(env)).resolves.toBeUndefined();
      const [command, args, options] = spawn.mock.calls.at(-1) as [
        string,
        string[],
        {
          detached: boolean;
          env: NodeJS.ProcessEnv;
          stdio: string;
          windowsHide: boolean;
          windowsVerbatimArguments: boolean;
        },
      ];
      expect(command).toBe(getWindowsCmdExePath());
      expect(args).toEqual(["/d", "/s", "/v:off", "/c", '""%OPENCLAW_TASK_SCRIPT%""']);
      expect(options.env.OPENCLAW_TASK_SCRIPT).toBe(scriptPath);
      expect(options.env.BOUNDARY_PARENT_ONLY).toBe("synthetic");
      expect(spawnSync).toHaveBeenCalledOnce();
      expect(spawnSync.mock.calls[0]?.[2]?.env).toMatchObject({ OPENCLAW_TASK_SCRIPT: scriptPath });
      expect(spawnSync.mock.calls[0]?.[2]?.env).not.toHaveProperty("BOUNDARY_PARENT_ONLY");
      expect(options.detached).toBe(true);
      expect(options.stdio).toBe("ignore");
      expect(options.windowsHide).toBe(true);
      expect(options.windowsVerbatimArguments).toBe(true);
      expect(childUnref).toHaveBeenCalledOnce();
    });
  });
});
