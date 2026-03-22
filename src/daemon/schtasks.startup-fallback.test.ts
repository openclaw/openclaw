import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quoteCmdScriptArg } from "./cmd-argv.js";
import "./test-helpers/schtasks-base-mocks.js";
import {
  inspectPortUsage,
  killProcessTree,
  resetSchtasksBaseMocks,
  schtasksResponses,
  withWindowsEnv,
  writeGatewayConfig,
  writeGatewayScript,
} from "./test-helpers/schtasks-fixtures.js";
const childUnref = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn(() => ({ unref: childUnref })));

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
  stopScheduledTask,
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

async function writeStartupFallbackEntry(env: Record<string, string>) {
  const startupEntryPath = resolveStartupEntryPath(env);
  await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
  await fs.writeFile(startupEntryPath, "@echo off\r\n", "utf8");
  return startupEntryPath;
}

async function writeStartupFallbackLauncher(env: Record<string, string>, scriptPath: string) {
  const startupEntryPath = resolveStartupEntryPath(env);
  await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
  await fs.writeFile(
    startupEntryPath,
    `@echo off\r\nstart "" /min cmd.exe /d /c ${quoteCmdScriptArg(scriptPath)}\r\n`,
    "utf8",
  );
  return startupEntryPath;
}

function expectStartupFallbackSpawn(env: Record<string, string>) {
  expect(spawn).toHaveBeenCalledWith(
    "cmd.exe",
    ["/d", "/s", "/c", quoteCmdScriptArg(resolveTaskScriptPath(env))],
    expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
  );
}

function expectGatewayTermination(pid: number) {
  if (process.platform === "win32") {
    expect(killProcessTree).not.toHaveBeenCalled();
    return;
  }
  expect(killProcessTree).toHaveBeenCalledWith(pid, { graceMs: 300 });
}

function addStartupFallbackMissingResponses(
  extraResponses: Array<{ code: number; stdout: string; stderr: string }> = [],
) {
  schtasksResponses.push(
    { code: 0, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "not found" },
    ...extraResponses,
  );
}
beforeEach(() => {
  resetSchtasksBaseMocks();
  spawn.mockClear();
  childUnref.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Windows startup fallback", () => {
  it("falls back to a Startup-folder launcher when schtasks create is denied", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
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
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
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
      expectStartupFallbackSpawn(env);
    });
  });

  it("treats an installed Startup-folder launcher as loaded", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);

      await expect(isScheduledTaskInstalled({ env })).resolves.toBe(true);
    });
  });

  it("reports runtime from the gateway listener when using the Startup fallback", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);
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
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
      ]);
      await writeStartupFallbackEntry(env);
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
      expectGatewayTermination(5151);
      expectStartupFallbackSpawn(env);
    });
  });

  it("restarts the Startup fallback with the installed legacy script when OPENCLAW_HOME moves", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env, tmpDir }) => {
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
      ]);
      const legacyEnv = { ...env };
      const movedEnv = { ...env, OPENCLAW_HOME: path.join(tmpDir, "moved-home") };
      await writeGatewayScript(legacyEnv);
      await writeStartupFallbackEntry(movedEnv);
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 5252, command: "node.exe" }],
        hints: [],
      });

      const stdout = new PassThrough();
      await expect(restartScheduledTask({ env: movedEnv, stdout })).resolves.toEqual({
        outcome: "completed",
      });

      expectGatewayTermination(5252);
      expect(spawn).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", quoteCmdScriptArg(resolveTaskScriptPath(legacyEnv))],
        expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
      );
    });
  });

  it("restarts the Startup fallback with the installed custom-home script when the caller OPENCLAW_HOME changes", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env, tmpDir }) => {
      addStartupFallbackMissingResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not found" },
      ]);
      const taskHome = path.join(tmpDir, "task-home");
      const shellHome = path.join(tmpDir, "shell-home");
      const taskEnv = { ...env, OPENCLAW_HOME: taskHome };
      const shellEnv = { ...env, OPENCLAW_HOME: shellHome };
      await writeGatewayScript(taskEnv, 18789, {
        includePortEnv: false,
        includePortFlag: false,
        extraEnv: { OPENCLAW_HOME: taskHome },
      });
      await writeGatewayConfig(taskEnv, 18789);
      await writeGatewayConfig(shellEnv, 29999);
      await writeStartupFallbackLauncher(shellEnv, resolveTaskScriptPath(taskEnv));
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 5454, command: "node.exe" }],
        hints: [],
      });

      const stdout = new PassThrough();
      const envWithoutPort: Record<string, string> = { ...shellEnv };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      await expect(restartScheduledTask({ env: envWithoutPort, stdout })).resolves.toEqual({
        outcome: "completed",
      });

      expectGatewayTermination(5454);
      expect(spawn).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", quoteCmdScriptArg(resolveTaskScriptPath(taskEnv))],
        expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
      );
    });
  });

  it("kills the Startup fallback runtime even when the CLI env omits the gateway port", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      schtasksResponses.push({ code: 0, stdout: "", stderr: "" });
      await writeGatewayScript(env);
      await writeStartupFallbackEntry(env);
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 5151, command: "node.exe" }],
          hints: [],
        })
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
      const envWithoutPort = { ...env };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      await stopScheduledTask({ env: envWithoutPort, stdout });

      expectGatewayTermination(5151);
    });
  });

  it("skips blank current scripts and keeps probing legacy candidates", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env, tmpDir }) => {
      schtasksResponses.push({ code: 0, stdout: "", stderr: "" });
      const legacyEnv = { ...env };
      const movedEnv = { ...env, OPENCLAW_HOME: path.join(tmpDir, "moved-home") };
      const currentScriptPath = resolveTaskScriptPath(movedEnv);
      await fs.mkdir(path.dirname(currentScriptPath), { recursive: true });
      await fs.writeFile(currentScriptPath, "@echo off\r\nrem blank current script\r\n", "utf8");
      await writeGatewayScript(legacyEnv, 18789, {
        includePortEnv: false,
        includePortFlag: true,
      });
      await writeStartupFallbackEntry(movedEnv);
      inspectPortUsage
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 5353, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValueOnce({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 5353, command: "node.exe" }],
          hints: [],
        })
        .mockResolvedValueOnce({
          port: 18789,
          status: "free",
          listeners: [],
          hints: [],
        });

      const stdout = new PassThrough();
      const envWithoutPort: Record<string, string> = { ...movedEnv };
      delete envWithoutPort.OPENCLAW_GATEWAY_PORT;
      await stopScheduledTask({ env: envWithoutPort, stdout });

      expectGatewayTermination(5353);
    });
  });
});
