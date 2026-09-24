// Relaunches the gateway through the managed Windows scheduled task.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCmdScriptArg } from "../daemon/cmd-argv.js";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { renderCmdRestartLogSetup } from "../daemon/restart-logs.js";
import { resolveTaskScriptPath } from "../daemon/schtasks.js";
import { formatErrorMessage } from "./errors.js";
import type { RestartAttempt } from "./restart.types.js";
import { parseTcpPort, parseTcpPortFromArgs } from "./tcp-port.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { getWindowsCmdExePath } from "./windows-install-roots.js";
import { encodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

// Match the Windows CLI restart budget, including slow cold starts.
const TASK_RESTART_WAIT_SECONDS = 180;
const TASK_RESTART_RETRY_LIMIT = 12;
const TASK_RESTART_RETRY_DELAY_SEC = 1;

function quotePowerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveWindowsTaskName(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

function buildScheduledTaskRestartScript(params: {
  quotedLogPath: string;
  setupLines: string[];
  taskName: string;
  taskScriptPath?: string;
  port: number;
  entryPath: string;
  recoveryCommand: string;
}): string {
  const { quotedLogPath, setupLines, taskName, taskScriptPath, port } = params;
  const quotedTaskName = quoteCmdScriptArg(taskName);
  const waitForExitCommand = [
    "$ErrorActionPreference = 'Stop'",
    `$old = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
    `if ($null -ne $old -and -not $old.WaitForExit(${TASK_RESTART_WAIT_SECONDS * 1000})) { Write-Output 'Outgoing Gateway did not exit within ${TASK_RESTART_WAIT_SECONDS}s'; exit 1 }`,
    "exit 0",
  ].join("; ");
  const observeReplacementCommand = [
    "$ErrorActionPreference = 'Stop'",
    `$deadline = [DateTime]::UtcNow.AddSeconds(${TASK_RESTART_WAIT_SECONDS})`,
    `$entry = [regex]::Escape(${quotePowerShellSingleQuotedLiteral(params.entryPath)})`,
    "$boundary = '[\\s' + [char]34 + ']'",
    "do {",
    `$listeners = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`,
    "foreach ($listener in $listeners) {",
    `if ($listener.OwningProcess -eq ${process.pid}) { continue }`,
    "$candidate = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess)",
    `if ($candidate.ExecutablePath -eq ${quotePowerShellSingleQuotedLiteral(process.execPath)} -and $candidate.CommandLine -match ($boundary + $entry + $boundary) -and $candidate.CommandLine -match '(?:^|\\s)gateway(?:\\s|$)') {`,
    `Write-Output ('openclaw restart observed source=windows-task-handoff port=${port} pid=' + $listener.OwningProcess)`,
    "exit 0",
    "}",
    "}",
    "Start-Sleep -Seconds 1",
    "} while ([DateTime]::UtcNow -lt $deadline)",
    `Write-Output 'No matching replacement Gateway listener appeared within ${TASK_RESTART_WAIT_SECONDS}s'`,
    "exit 1",
  ].join("; ");
  const lines = [
    "@echo off",
    "setlocal",
    ...setupLines,
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart attempt source=windows-task-handoff target=${quotedTaskName} previousPid=${process.pid} port=${port}`,
    // Running can still describe the outgoing task. Never accept it as recovery.
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quoteCmdScriptArg(waitForExitCommand)} >> ${quotedLogPath} 2>&1`,
    "if errorlevel 1 goto failed",
    `schtasks /Query /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
    "if errorlevel 1 goto fallback",
    "set /a attempts=0",
    ":retry",
    `timeout /t ${TASK_RESTART_RETRY_DELAY_SEC} /nobreak >nul`,
    "set /a attempts+=1",
    `schtasks /Run /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
    "if not errorlevel 1 goto verify",
    `if %attempts% GEQ ${TASK_RESTART_RETRY_LIMIT} goto fallback`,
    "goto retry",
    ":fallback",
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart fallback source=windows-task-handoff`,
  ];
  if (taskScriptPath) {
    const quotedScript = quoteCmdScriptArg(taskScriptPath);
    const quotedCmd = quoteCmdScriptArg(getWindowsCmdExePath());
    lines.push(
      `if exist ${quotedScript} (`,
      `  start "" /min ${quotedCmd} /d /c ${quotedScript}`,
      ")",
    );
  }
  lines.push(
    ":verify",
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quoteCmdScriptArg(observeReplacementCommand)} >> ${quotedLogPath} 2>&1`,
    "if errorlevel 1 goto failed",
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart finished source=windows-task-handoff`,
    "goto cleanup",
    ":failed",
    // /End here could kill this observer inside the task's non-breakaway Job.
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart failed source=windows-task-handoff target=${quotedTaskName} previousPid=${process.pid} port=${port}. No replacement listener verified. Run from an external terminal: ${quoteCmdScriptArg(params.recoveryCommand)}`,
    ":cleanup",
    'del "%~f0" >nul 2>&1',
  );
  return lines.join("\r\n");
}

export function relaunchGatewayScheduledTask(env: NodeJS.ProcessEnv = process.env): RestartAttempt {
  const taskName = resolveWindowsTaskName(env);
  const taskScriptPath = resolveTaskScriptPath(env);
  const scriptPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-schtasks-restart-${randomUUID()}.cmd`,
  );
  const quotedScriptPath = quoteCmdScriptArg(scriptPath);
  const restartLog = renderCmdRestartLogSetup({ ...process.env, ...env });
  try {
    const port = parseTcpPortFromArgs(process.argv) ?? parseTcpPort(env.OPENCLAW_GATEWAY_PORT);
    const entryPath = process.argv[1];
    if (!port || !entryPath) {
      throw new Error("Cannot identify the Gateway entrypoint and port for restart observation");
    }
    // The script embeds host paths and the task name; cmd.exe decodes it with
    // the console code page, so plain UTF-8 garbles CJK content (#107416).
    fs.writeFileSync(
      scriptPath,
      encodeWindowsLauncherScript({
        format: "cmd",
        content: `${buildScheduledTaskRestartScript({
          quotedLogPath: restartLog.quotedLogPath,
          setupLines: restartLog.lines,
          taskName,
          taskScriptPath,
          port,
          entryPath,
          recoveryCommand: formatCliCommand("openclaw gateway restart --force", env),
        })}\r\n`,
      }),
    );
    const cmdExePath = getWindowsCmdExePath();
    const child = spawn(cmdExePath, ["/d", "/s", "/c", quotedScriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return {
      ok: true,
      method: "schtasks",
      tried: [`schtasks /Run /TN "${taskName}"`, `${cmdExePath} /d /s /c ${quotedScriptPath}`],
    };
  } catch (err) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup; keep the original restart failure.
    }
    return {
      ok: false,
      method: "schtasks",
      detail: formatErrorMessage(err),
      tried: [`schtasks /Run /TN "${taskName}"`],
    };
  }
}
