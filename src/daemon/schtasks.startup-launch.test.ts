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

async function writeCmdScript(env: Record<string, string | undefined>) {
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, "@echo off\r\nrem no parsed command\r\n", "utf8");
  return scriptPath;
}

describe("Windows Startup launcher", () => {
  it("rejects asynchronous cmd spawn failure without detaching", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      await writeCmdScript(env);
      const error = Object.assign(new Error("spawn cmd ENOENT"), { code: "ENOENT" });
      spawn.mockImplementationOnce(() => createSpawnChild(childUnref, error));
      await expect(launchFallbackTaskScript(env)).rejects.toThrow("spawn cmd ENOENT");
      expect(childUnref).not.toHaveBeenCalled();
    });
  });

  it("rejects cmd ACL script access before spawning", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env, tmpDir }) => {
      env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state & %USERPROFILE%");
      const scriptPath = await writeCmdScript(env);
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

  it.each(["supervisor", "cmd"])("detaches the %s launcher only after admission", async (kind) => {
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    await withWindowsEnv("openclaw-win-startup-", async ({ env, tmpDir }) => {
      env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state & %USERPROFILE% !");
      const scriptPath = resolveTaskScriptPath(env);
      if (kind === "cmd") {
        await writeCmdScript(env);
      }
      await expect(
        launchFallbackTaskScript(
          env,
          kind === "supervisor"
            ? {
                programArguments: ["C:\\Program Files\\nodejs\\node.exe", "gateway.js"],
                environment: { OPENCLAW_SERVICE_KIND: "gateway" },
              }
            : undefined,
        ),
      ).resolves.toBeUndefined();
      expect(spawn.mock.calls.at(-1)).toEqual([
        kind === "cmd" ? getWindowsCmdExePath() : "C:\\Program Files\\nodejs\\node.exe",
        kind === "cmd"
          ? ["/d", "/s", "/v:off", "/c", '""%OPENCLAW_TASK_SCRIPT%""']
          : ["gateway.js", "--task-supervisor"],
        expect.objectContaining({
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          ...(kind === "cmd" ? { windowsVerbatimArguments: true } : {}),
          env: expect.objectContaining({
            BOUNDARY_PARENT_ONLY: "synthetic",
            ...(kind === "cmd" ? { OPENCLAW_TASK_SCRIPT: scriptPath } : {}),
          }),
        }),
      ]);
      if (kind === "cmd") {
        expect(spawnSync).toHaveBeenCalledOnce();
        expect(spawnSync.mock.calls[0]?.[2]?.env).toMatchObject({
          OPENCLAW_TASK_SCRIPT: scriptPath,
        });
        expect(spawnSync.mock.calls[0]?.[2]?.env).not.toHaveProperty("BOUNDARY_PARENT_ONLY");
      }
      expect(childUnref).toHaveBeenCalledOnce();
    });
  });
});
