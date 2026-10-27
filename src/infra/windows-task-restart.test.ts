import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getWindowsCmdExePath } from "./windows-install-roots.js";
import { decodeWindowsLauncherScript } from "./windows-launcher-encoding.js";
import { relaunchGatewayScheduledTask } from "./windows-task-restart.js";

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn(() => os.tmpdir()));
const resolveTaskScriptPathMock = vi.hoisted(() => vi.fn<(env: NodeJS.ProcessEnv) => string>());
// Prevent host OEM probes from affecting script encoding assertions.
const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: spawnMock },
  );
});
// mock-isolation: keep launcher scripts inside the test-owned temporary root.
vi.mock("./tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));
vi.mock("../daemon/schtasks-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/schtasks-layout.js")>()),
  resolveTaskScriptPath: resolveTaskScriptPathMock,
}));
vi.mock("./windows-encoding.js", async (original) => ({
  ...(await original<typeof import("./windows-encoding.js")>()),
  resolveWindowsOemCodePage: () => 437,
  resolveWindowsOemEncoding: resolveWindowsOemEncodingMock,
}));

const originalArgv = [...process.argv];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let scriptPath: string | undefined;
const unref = vi.fn();
const readScript = () => fs.readFileSync(expectDefined(scriptPath, "helper path"), "utf8");

function executeRestart(command: (line: string) => number, env: NodeJS.ProcessEnv = {}) {
  expect(relaunchGatewayScheduledTask(env).ok).toBe(true);
  const commands: string[] = [];
  const output = runRestartBatch(readScript(), (line) => {
    commands.push(line);
    return command(line);
  }).join("\n");
  return { commands, output };
}

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
  process.argv = [...originalArgv];
  scriptPath = undefined;
});

beforeEach(() => {
  process.argv = [process.execPath, "C:\\OpenClaw\\dist\\entry.js", "gateway", "--port", "18789"];
  unref.mockReset();
  spawnMock.mockReset().mockImplementation((_file: string, args: string[]) => {
    scriptPath = decodeCmdPathArg(expectDefined(args[3], "helper path"));
    return { unref };
  });
  resolvePreferredOpenClawTmpDirMock.mockReset().mockReturnValue(tempDirs.make("task-restart-"));
  resolveTaskScriptPathMock.mockReset().mockImplementation((env) => {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    return path.join(home, ".openclaw", "gateway.cmd");
  });
  resolveWindowsOemEncodingMock.mockReset().mockReturnValue(null);
});

it("writes a detached schtasks relaunch helper", () => {
  const tmpDir = tempDirs.make("openclaw&(restart)-");
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(tmpDir);
  const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });
  const cmdExePath = getWindowsCmdExePath();
  const spawnCall = expectDefined(spawnMock.mock.calls[0], "restart helper spawn call");
  const seenCommandArg = expectDefined(spawnCall[1][3], "scheduled-task command argument");
  expect(spawnMock).toHaveBeenCalledOnce();
  expect(seenCommandArg.startsWith('"')).toBe(true);
  expect(seenCommandArg.endsWith('"')).toBe(true);
  expect(seenCommandArg).toContain("&");
  expect(result).toMatchObject({ ok: true, method: "schtasks" });
  expect(spawnCall).toStrictEqual([
    cmdExePath,
    ["/d", "/s", "/c", seenCommandArg],
    { detached: true, stdio: "ignore", windowsHide: true },
  ]);
  expect(unref).toHaveBeenCalledOnce();
  const script = readScript();
  // ASCII helper scripts stay marker-free UTF-8 bytes.
  expect(script.startsWith("@echo off\r\n")).toBe(true);
  for (const fragment of [
    `Get-Process -Id ${process.pid}`,
    "WaitForExit(180000)",
    "$deadline = [DateTime]::UtcNow.AddSeconds(",
    "} while ([DateTime]::UtcNow -lt $deadline)",
    "gateway-restart.log",
    'openclaw restart attempt source=windows-task-handoff target="OpenClaw Gateway (work)"',
    "Get-NetTCPConnection -LocalPort 18789 -State Listen",
    `$listener.OwningProcess -eq ${process.pid}`,
    "$candidate.ExecutablePath -eq",
    "$candidate.CommandLine -match ($boundary + $entry + $boundary)",
    'schtasks /Run /TN "OpenClaw Gateway (work)" >>',
    'del "%~f0" >nul 2>&1',
  ]) {
    expect(script).toContain(fragment);
  }
  expect(script).not.toContain("Get-ScheduledTask");
});

it.each([
  ["WaitForExit", "work", false, false],
  ["", "work", true, true],
  ["Get-NetTCPConnection", undefined, false, true],
  ["schtasks /Run", undefined, true, true],
] as const)("handles restart failure at %s", (failure, profile, finished, launched) => {
  const { commands, output } = executeRestart(
    (line) => (failure && line.includes(failure) ? 1 : 0),
    { OPENCLAW_PROFILE: profile, OPENCLAW_GATEWAY_PORT: "18789" },
  );
  expect([
    commands.some((line) => line.startsWith("schtasks /Run")),
    output.includes("restart finished"),
    output.includes("restart failed"),
    commands.some((line) => line.includes("Get-NetTCPConnection")),
  ]).toEqual([launched, finished, !finished, launched]);
  if (failure === "WaitForExit") {
    expect(output).toContain("openclaw --profile work gateway restart --force");
  }
  if (failure === "Get-NetTCPConnection") {
    expect(output).toContain("restart failed source=windows-task-handoff");
    expect(output).toContain("openclaw gateway restart --force");
    expect(commands.filter((line) => line.startsWith("schtasks /Run"))).toHaveLength(1);
  }
  if (failure === "schtasks /Run") {
    expect(commands.filter((line) => line.startsWith('start ""'))).toHaveLength(1);
    expect(commands.at(-1)).toContain("Get-NetTCPConnection");
  }
});

it("retains an unidentified Gateway", () => {
  process.argv = [process.execPath, "C:\\OpenClaw\\dist\\entry.js", "gateway"];
  const result = relaunchGatewayScheduledTask({});
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("Cannot identify the Gateway entrypoint and port");
  expect(spawnMock).not.toHaveBeenCalled();
});

it("isolates task names from PowerShell observation", () => {
  process.argv[1] = "C:\\OpenClaw\\Bob's ‘gateway’ ‚‛\\entry.js";
  resolveWindowsOemEncodingMock.mockReturnValue("utf8");
  const observations: string[][] = [];
  for (const taskName of ["OpenClaw Gateway", "OpenClaw Gateway (Bob's work)"]) {
    const result = relaunchGatewayScheduledTask({
      // Log paths may contain the same text as the task name without affecting observation.
      OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "Bob-restart-logs"),
      OPENCLAW_WINDOWS_TASK_NAME: taskName,
    });
    expect(result.ok).toBe(true);
    const script = readScript();
    expect(script).toContain(`schtasks /Run /TN "${taskName}"`);
    observations.push(script.split("\r\n").filter((line) => line.startsWith("powershell.exe")));
    expect(script).not.toContain("findstr");
  }
  expect(observations[0]).toHaveLength(2);
  expect(observations[1]).toEqual(observations[0]);
  expect(observations[0]?.[1]).toContain(
    "$entry = [regex]::Escape('C:\\OpenClaw\\Bob''s ‘‘gateway’’ ‚‚‛‛\\entry.js')",
  );
});

it("roundtrips marked CJK task names", () => {
  resolveWindowsOemEncodingMock.mockReturnValue("gbk");
  const result = relaunchGatewayScheduledTask({
    // Keep host paths ASCII; only the task name tests GBK encoding.
    HOME: "C:\\ocw-test",
    USERPROFILE: "C:\\ocw-test",
    OPENCLAW_STATE_DIR: "C:\\ocw-test\\state",
    OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (隆)",
  });
  expect(result.ok).toBe(true);
  const raw = fs.readFileSync(expectDefined(scriptPath, "helper path"));
  expect(
    raw.toString("latin1").startsWith("@chcp 936 >nul\r\n@rem openclaw-launcher-encoding=gbk\r\n"),
  ).toBe(true);
  // The old raw-UTF-8 writer would have kept the task name readable here.
  expect(raw.toString("utf8")).not.toContain("隆");
  const script = decodeWindowsLauncherScript({ buffer: raw });
  expect(script.startsWith("@echo off\r\n")).toBe(true);
  expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (隆)" >>');
  expect(script).toContain('del "%~f0" >nul 2>&1');
});
