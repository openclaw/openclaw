import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./test-helpers/schtasks-base-mocks.js";
import { resolveTaskScriptPath, restartScheduledTask, stopScheduledTask } from "./schtasks.js";
import {
  inspectPortUsageMock,
  killProcessTreeMock,
  resetSchtasksBaseMocks,
  schtasksCalls,
  withWindowsEnv,
} from "./test-helpers/schtasks-fixtures.js";

const spawnSync = vi.hoisted(() =>
  vi.fn<(exe: string, args?: readonly string[]) => SpawnSyncReturns<string>>(),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));

beforeEach(() => {
  resetSchtasksBaseMocks();
  spawnSync.mockReset();
  spawnSync.mockImplementation((exe: string) => ({
    pid: 0,
    output: [null, "No tasks", ""],
    stdout: "No tasks",
    stderr: "",
    status: /(?:taskkill|tasklist)\.exe$/i.test(exe) ? 0 : 1,
    signal: null,
  }));
});
afterEach(() => vi.restoreAllMocks());

it.each([
  { operation: "stop", control: stopScheduledTask },
  { operation: "restart", control: restartScheduledTask },
])(
  "refuses shortened argv from an unquoted redirect expansion during $operation",
  async ({ control }) => {
    await withWindowsEnv("openclaw-win-redirect-", async ({ env }) => {
      const commandLine =
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\OpenClaw\\gateway.js" gateway --port 18789';
      const scriptPath = resolveTaskScriptPath(env);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(
        scriptPath,
        [
          "@echo off",
          'set "OPENCLAW_TEST_LOG_PATH=C:\\Logs\\gateway output.log"',
          `${commandLine} < NUL >> %OPENCLAW_TEST_LOG_PATH% 2>&1`,
        ].join("\r\n"),
      );
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      inspectPortUsageMock.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 6262, command: "node.exe", commandLine, address: "127.0.0.1:18789" }],
        hints: [],
      });

      const failure = await control({ env, stdout: new PassThrough() }).catch(
        (err: unknown) => err,
      );

      expect(spawnSync.mock.calls.filter(([exe]) => /taskkill\.exe$/i.test(exe))).toEqual([]);
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      expect(String(failure)).toContain("remaining listener ownership could not be verified");
      expect(String(failure)).toContain("quote the entire redirection target");
      expect(schtasksCalls.some((args) => args[0] === "/Run")).toBe(false);
    });
  },
);
