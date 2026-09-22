// Covers Windows scheduled-task gateway restart script generation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";
import { getWindowsCmdExePath } from "./windows-install-roots.js";
import { decodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn(() => os.tmpdir()));
const resolveTaskScriptPathMock = vi.hoisted(() =>
  vi.fn((env: Record<string, string | undefined>) => {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    return path.join(home, ".openclaw", "gateway.cmd");
  }),
);
// Pin code page detection so hosts with CJK home paths cannot leak the real
// registry OEM probe into script-encoding assertions.
const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: (...args: unknown[]) => spawnMock(...args),
    },
  );
});
vi.mock("./tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => resolvePreferredOpenClawTmpDirMock(),
}));
vi.mock("../daemon/schtasks.js", () => ({
  resolveTaskScriptPath: (env: Record<string, string | undefined>) =>
    resolveTaskScriptPathMock(env),
}));
vi.mock("./windows-encoding.js", async () => {
  const actual =
    await vi.importActual<typeof import("./windows-encoding.js")>("./windows-encoding.js");
  return {
    ...actual,
    resolveWindowsOemCodePage: () => 437,
    resolveWindowsOemEncoding: () => resolveWindowsOemEncodingMock(),
  };
});

type WindowsTaskRestartModule = typeof import("./windows-task-restart.js");

let relaunchGatewayScheduledTask: WindowsTaskRestartModule["relaunchGatewayScheduledTask"];

const envSnapshot = captureFullEnv();
const originalArgv = [...process.argv];
const createdScriptPaths = new Set<string>();
const createdTmpDirs = new Set<string>();

function decodeCmdPathArg(value: string): string {
  const trimmed = value.trim();
  const withoutQuotes =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return withoutQuotes.replace(/\^!/g, "!").replace(/%%/g, "%");
}

// Execute the emitted batch control flow with native commands stubbed. Unknown
// syntax fails closed so a newly added branch cannot silently escape the proof.
function runRestartBatch(script: string, command: (line: string) => number): string[] {
  const lines = script.split(/\r?\n/).map((line) => line.trim());
  const output: string[] = [];
  let errorlevel = 0;
  let attempts = 0;
  for (let index = 0, steps = 0; index < lines.length; index += 1) {
    if (++steps > 1000) {
      throw new Error("Restart helper did not terminate");
    }
    const line = lines[index];
    if (
      !line ||
      line === ")" ||
      line.startsWith(":") ||
      /^(?:@echo off|setlocal|del )/.test(line)
    ) {
      continue;
    }
    const branch = /^(?:if (not )?errorlevel (\d+) )?goto (\w+)$/i.exec(line);
    if (branch) {
      const matched = branch[2] === undefined || errorlevel >= Number(branch[2]);
      if (branch[1] ? !matched : matched) {
        const target = lines.indexOf(`:${branch[3]}`);
        if (target < 0) {
          throw new Error(`Missing batch label: ${branch[3]}`);
        }
        index = target;
      }
      continue;
    }
    if (line === "set /a attempts=0") {
      attempts = 0;
    } else if (line === "set /a attempts+=1") {
      attempts += 1;
    } else if (line.startsWith("if %attempts% GEQ ")) {
      const limit = Number(line.split(" ")[3]);
      if (attempts >= limit) {
        index = lines.indexOf(`:${line.split(" ")[5]}`);
      }
    } else if (line.startsWith(">> ") && line.includes(" echo ")) {
      output.push(line.slice(line.indexOf(" echo ") + 6));
    } else if (line.startsWith("if not exist ") || line.startsWith("timeout ")) {
      continue;
    } else if (line.startsWith("if exist ") && line.endsWith(" (")) {
      if (command(line) !== 0) {
        const end = lines.indexOf(")", index + 1);
        if (end < 0) {
          throw new Error("Missing batch block end");
        }
        index = end;
      }
    } else if (/^(?:powershell\.exe|schtasks |start )/.test(line)) {
      errorlevel = command(line);
    } else {
      throw new Error(`Unsupported restart batch syntax: ${line}`);
    }
  }
  return output;
}

afterEach(() => {
  envSnapshot.restore();
  process.argv = [...originalArgv];
  for (const scriptPath of createdScriptPaths) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup for temp helper scripts created in tests.
    }
  }
  createdScriptPaths.clear();
  for (const tmpDir of createdTmpDirs) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for test temp roots.
    }
  }
  createdTmpDirs.clear();
});

describe("relaunchGatewayScheduledTask", () => {
  beforeAll(async () => {
    ({ relaunchGatewayScheduledTask } = await import("./windows-task-restart.js"));
  });

  beforeEach(() => {
    process.argv = [process.execPath, "C:\\OpenClaw\\dist\\entry.js", "gateway", "--port", "18789"];
    spawnMock.mockReset();
    resolvePreferredOpenClawTmpDirMock.mockReset();
    resolvePreferredOpenClawTmpDirMock.mockReturnValue(os.tmpdir());
    resolveTaskScriptPathMock.mockReset();
    resolveTaskScriptPathMock.mockImplementation((env: Record<string, string | undefined>) => {
      const home = env.USERPROFILE || env.HOME || os.homedir();
      return path.join(home, ".openclaw", "gateway.cmd");
    });
    resolveWindowsOemEncodingMock.mockReset();
    resolveWindowsOemEncodingMock.mockReturnValue(null);
  });

  it("writes a detached schtasks relaunch helper", () => {
    const unref = vi.fn();
    let seenCommandArg = "";
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      seenCommandArg = expectDefined(args[3], "scheduled-task command argument");
      createdScriptPaths.add(decodeCmdPathArg(seenCommandArg));
      return { unref };
    });

    const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });
    const cmdExePath = getWindowsCmdExePath();

    expect(result.ok).toBe(true);
    expect(result.method).toBe("schtasks");
    expect(result.tried).toContain('schtasks /Run /TN "OpenClaw Gateway (work)"');
    expect(result.tried).toContain(`${cmdExePath} /d /s /c ${seenCommandArg}`);
    const spawnCall = expectDefined(spawnMock.mock.calls[0], "restart helper spawn call");
    expect(spawnCall[0]).toBe(cmdExePath);
    expect(spawnCall[1]).toStrictEqual(["/d", "/s", "/c", seenCommandArg]);
    expect(spawnCall[2]).toStrictEqual({
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(unref).toHaveBeenCalledOnce();

    const scriptPath = [...createdScriptPaths][0];
    if (scriptPath === undefined) {
      throw new Error("expected restart helper script path");
    }
    expect(fs.statSync(scriptPath).isFile()).toBe(true);
    const script = fs.readFileSync(scriptPath, "utf8");
    // ASCII helper scripts stay marker-free UTF-8 bytes.
    expect(script.startsWith("@echo off\r\n")).toBe(true);
    expect(script).toContain(`Get-Process -Id ${process.pid}`);
    expect(script).toContain("WaitForExit(180000)");
    expect(script).toContain("gateway-restart.log");
    expect(script).toContain(
      'openclaw restart attempt source=windows-task-handoff target="OpenClaw Gateway (work)"',
    );
    expect(script).not.toContain("Get-ScheduledTask");
    expect(script).toContain("Get-NetTCPConnection -LocalPort 18789 -State Listen");
    expect(script).toContain(`$listener.OwningProcess -eq ${process.pid}`);
    expect(script).toContain("$candidate.ExecutablePath -eq");
    expect(script).toContain("$candidate.CommandLine -match ($boundary + $entry + $boundary)");
    expect(script).not.toContain("findstr");
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (work)" >>');
    expect(script.indexOf("powershell.exe -NoProfile")).toBeLessThan(
      script.indexOf('schtasks /Run /TN "OpenClaw Gateway (work)"'),
    );
    expect(script).toContain('del "%~f0" >nul 2>&1');
  });

  it.each([true, false])(
    "does not report a finished restart without a replacement listener (task running=%s)",
    (taskRunning) => {
      spawnMock.mockImplementation((_file: string, args: string[]) => {
        createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "helper path")));
        return { unref: vi.fn() };
      });
      expect(relaunchGatewayScheduledTask({ OPENCLAW_GATEWAY_PORT: "18789" }).ok).toBe(true);
      const scriptPath = expectDefined([...createdScriptPaths][0], "helper path");
      const commands: string[] = [];
      const output = runRestartBatch(fs.readFileSync(scriptPath, "utf8"), (line) => {
        commands.push(line);
        if (line.includes("Get-ScheduledTask")) {
          return taskRunning ? 0 : 1;
        }
        // The outgoing PID exits, but Scheduler accepts /Run without launching.
        return line.includes("Get-NetTCPConnection") ? 1 : 0;
      });
      expect(output.join("\n")).not.toContain("restart finished");
      expect(output.join("\n")).toContain("restart failed source=windows-task-handoff");
      expect(output.join("\n")).toContain("openclaw gateway restart --force");
      expect(commands.filter((line) => line.startsWith("schtasks /Run"))).toHaveLength(1);
    },
  );

  it.each([true, false])(
    "requires outgoing process exit before launching (exited=%s)",
    (exited) => {
      spawnMock.mockImplementation((_file: string, args: string[]) => {
        createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "helper path")));
        return { unref: vi.fn() };
      });
      expect(relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" }).ok).toBe(true);
      const scriptPath = expectDefined([...createdScriptPaths][0], "helper path");
      const commands: string[] = [];
      const output = runRestartBatch(fs.readFileSync(scriptPath, "utf8"), (line) => {
        commands.push(line);
        return line.includes("WaitForExit") && !exited ? 1 : 0;
      });
      expect(commands.some((line) => line.startsWith("schtasks /Run"))).toBe(exited);
      expect(output.some((line) => line.includes("restart finished"))).toBe(exited);
      expect(output.some((line) => line.includes("restart failed"))).toBe(!exited);
      expect(commands.some((line) => line.includes("Get-NetTCPConnection"))).toBe(exited);
      if (!exited) {
        expect(output.join("\n")).toContain("openclaw --profile work gateway restart --force");
      }
    },
  );

  it("retains the current Gateway when its listener cannot be identified", () => {
    process.argv = [process.execPath, "C:\\OpenClaw\\dist\\entry.js", "gateway"];
    const result = relaunchGatewayScheduledTask({});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Cannot identify the Gateway entrypoint and port");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("preserves verified launcher recovery when a registered task rejects launch", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "helper path")));
      return { unref: vi.fn() };
    });
    expect(relaunchGatewayScheduledTask({}).ok).toBe(true);
    const scriptPath = expectDefined([...createdScriptPaths][0], "helper path");
    const commands: string[] = [];
    const output = runRestartBatch(fs.readFileSync(scriptPath, "utf8"), (line) => {
      commands.push(line);
      return line.startsWith("schtasks /Run") ? 1 : 0;
    });
    expect(commands.filter((line) => line.startsWith('start ""'))).toHaveLength(1);
    expect(commands.at(-1)).toContain("Get-NetTCPConnection");
    expect(output.join("\n")).toContain("restart finished");
    expect(output.join("\n")).not.toContain("restart failed");
  });

  it("prefers OPENCLAW_WINDOWS_TASK_NAME overrides", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "args[3] test invariant")));
      return { unref: vi.fn() };
    });

    relaunchGatewayScheduledTask({
      OPENCLAW_PROFILE: "work",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (custom)",
    });

    const scriptPath = expectDefined(
      [...createdScriptPaths][0],
      "[...createdScriptPaths][0] test invariant",
    );
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (custom)" >>');
  });

  it("keeps custom task names out of the PowerShell observation commands", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "args[3] test invariant")));
      return { unref: vi.fn() };
    });

    relaunchGatewayScheduledTask({
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (Bob's work)",
    });

    const scriptPath = expectDefined(
      [...createdScriptPaths][0],
      "[...createdScriptPaths][0] test invariant",
    );
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (Bob\'s work)"');
    expect(
      script
        .split("\r\n")
        .filter((line) => line.startsWith("powershell.exe"))
        .join("\n"),
    ).not.toContain("Bob");
    expect(script).not.toContain("findstr");
  });

  it("returns failed when the helper cannot be spawned", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    expect(result.ok).toBe(false);
    expect(result.method).toBe("schtasks");
    expect(result.detail).toContain("spawn failed");
  });

  it("quotes the cmd /c script path when temp paths contain metacharacters", () => {
    const unref = vi.fn();
    const metacharTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw&(restart)-"));
    createdTmpDirs.add(metacharTmpDir);
    resolvePreferredOpenClawTmpDirMock.mockReturnValue(metacharTmpDir);
    spawnMock.mockReturnValue({ unref });

    relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    expect(spawnMock).toHaveBeenCalledOnce();
    const spawnCall = expectDefined(spawnMock.mock.calls[0], "restart helper spawn call");
    const commandArgs = spawnCall[1];
    if (!Array.isArray(commandArgs)) {
      throw new Error("expected cmd.exe argument array");
    }
    const commandArg = commandArgs[3];
    if (typeof commandArg !== "string") {
      throw new Error("expected quoted restart helper path");
    }
    expect(spawnCall[0]).toBe(getWindowsCmdExePath());
    expect(commandArgs).toStrictEqual(["/d", "/s", "/c", commandArg]);
    expect(commandArg.startsWith('"')).toBe(true);
    expect(commandArg.endsWith('"')).toBe(true);
    expect(commandArg).toContain("&");
    expect(spawnCall[2]).toStrictEqual({
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("includes startup fallback", () => {
    const taskScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-"));
    createdTmpDirs.add(taskScriptDir);
    const taskScriptPath = path.join(taskScriptDir, "gateway.cmd");
    fs.writeFileSync(taskScriptPath, "@echo off\r\nrem placeholder\r\n", "utf8");
    resolveTaskScriptPathMock.mockReturnValue(taskScriptPath);

    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "args[3] test invariant")));
      return { unref: vi.fn() };
    });

    const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    expect(result.ok).toBe(true);
    const scriptPath = expectDefined(
      [...createdScriptPaths][0],
      "[...createdScriptPaths][0] test invariant",
    );
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain(`schtasks /Query /TN`);
    expect(script).toContain(":fallback");
    expect(script).toContain(`start "" /min ${getWindowsCmdExePath()} /d /c`);
    expect(script).toContain(taskScriptPath);
  });

  // Pin the host home/state paths embedded in the script to ASCII so the only
  // code-page-sensitive content in the gbk tests is the task name under test;
  // otherwise a non-GBK Windows username (Hangul/Thai/...) fails the encode.
  const asciiPathEnv = {
    HOME: "C:\\ocw-test",
    USERPROFILE: "C:\\ocw-test",
    OPENCLAW_STATE_DIR: "C:\\ocw-test\\state",
  };

  it("writes marked code-page bytes for CJK task names that decode back exactly", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("gbk");
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "args[3] test invariant")));
      return { unref: vi.fn() };
    });

    const result = relaunchGatewayScheduledTask({
      ...asciiPathEnv,
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (隆)",
    });

    expect(result.ok).toBe(true);
    const scriptPath = expectDefined(
      [...createdScriptPaths][0],
      "[...createdScriptPaths][0] test invariant",
    );
    const raw = fs.readFileSync(scriptPath);
    expect(
      raw
        .toString("latin1")
        .startsWith("@chcp 936 >nul\r\n@rem openclaw-launcher-encoding=gbk\r\n"),
    ).toBe(true);
    // The old raw-UTF-8 writer would have kept the task name readable here.
    expect(raw.toString("utf8")).not.toContain("隆");
    const script = decodeWindowsLauncherScript({ buffer: raw });
    expect(script.startsWith("@echo off\r\n")).toBe(true);
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (隆)" >>');
    expect(script).toContain('del "%~f0" >nul 2>&1');
  });

  it("returns failed instead of writing an unrepresentable helper script", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("gbk");
    spawnMock.mockImplementation(() => {
      throw new Error("spawn should not be reached");
    });

    const result = relaunchGatewayScheduledTask({
      ...asciiPathEnv,
      OPENCLAW_WINDOWS_TASK_NAME: "🚀",
    });

    expect(result.ok).toBe(false);
    expect(result.method).toBe("schtasks");
    expect(result.detail).toMatch(/cannot be represented/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
