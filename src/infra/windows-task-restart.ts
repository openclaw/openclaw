import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { quoteCmdScriptArg } from "../daemon/cmd-argv.js";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { resolveTaskScriptPath } from "../daemon/schtasks.js";
import { formatErrorMessage } from "./errors.js";
import type { RestartAttempt } from "./restart.types.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const TASK_RESTART_RETRY_LIMIT = 12;
const TASK_RESTART_RETRY_DELAY_SEC = 1;

function resolveWindowsTaskName(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

function buildScheduledTaskRestartScript(taskName: string, taskScriptPath?: string): string {
  const quotedTaskName = quoteCmdScriptArg(taskName);
  const lines = [
    "@echo off",
    "setlocal",
    `schtasks /Query /TN ${quotedTaskName} >nul 2>&1`,
    "if errorlevel 1 goto fallback",
    "set /a attempts=0",
    ":retry",
    `timeout /t ${TASK_RESTART_RETRY_DELAY_SEC} /nobreak >nul`,
    "set /a attempts+=1",
    `schtasks /Run /TN ${quotedTaskName} >nul 2>&1`,
    "if not errorlevel 1 goto cleanup",
    `if %attempts% GEQ ${TASK_RESTART_RETRY_LIMIT} goto fallback`,
    "goto retry",
    ":fallback",
  ];
  if (taskScriptPath) {
    const quotedScript = quoteCmdScriptArg(taskScriptPath);
    lines.push(`if exist ${quotedScript} (`, `  start "" /min cmd.exe /d /c ${quotedScript}`, ")");
  }
  lines.push(":cleanup", 'del "%~f0" >nul 2>&1');
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
  try {
    fs.writeFileSync(
      scriptPath,
      `${buildScheduledTaskRestartScript(taskName, taskScriptPath)}\r\n`,
      "utf8",
    );
    const child = spawn("cmd.exe", ["/d", "/s", "/c", quotedScriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return {
      ok: true,
      method: "schtasks",
      tried: [`schtasks /Run /TN "${taskName}"`, `cmd.exe /d /s /c ${quotedScriptPath}`],
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
