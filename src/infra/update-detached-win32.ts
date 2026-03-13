/**
 * Windows detached update helper.
 *
 * On Windows, `npm i -g openclaw@latest` fails with EBUSY when the Gateway
 * process is still running because Node.js keeps loaded `.js` files locked.
 *
 * This module spawns a detached `.cmd` script that:
 *   1. Waits for the current Gateway process (by PID) to exit
 *   2. Runs the npm global install command
 *   3. Re-launches the Gateway via its Scheduled Task
 *   4. Writes a JSON result file so the next Gateway boot can report the outcome
 *
 * The caller (update-runner) should schedule a graceful shutdown *after*
 * spawning this helper so the helper can proceed once the lock is released.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { quoteCmdScriptArg } from "../daemon/cmd-argv.js";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

/** Maximum seconds the helper will wait for the Gateway PID to disappear. */
const PID_WAIT_TIMEOUT_SEC = 60;
/** Seconds between PID-alive polls. */
const PID_POLL_INTERVAL_SEC = 2;
/** Retry limit for schtasks /Run after install completes. */
const TASK_RESTART_RETRY_LIMIT = 12;
const TASK_RESTART_RETRY_DELAY_SEC = 1;

export type DetachedUpdateResult = {
  ok: boolean;
  scriptPath: string;
  resultPath: string;
  detail?: string;
};

function resolveWindowsTaskName(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

/**
 * Build a `.cmd` batch script that:
 *   - Polls until `gatewayPid` is no longer alive (or timeout)
 *   - Executes `installArgv` (e.g. `npm i -g openclaw@latest ...`)
 *   - Restarts the Gateway via Scheduled Task
 *   - Writes a small JSON result to `resultPath`
 */
function buildDetachedUpdateScript(params: {
  gatewayPid: number;
  installCommand: string;
  taskName: string;
  resultPath: string;
}): string {
  const { gatewayPid, installCommand, taskName, resultPath } = params;
  const quotedTaskName = quoteCmdScriptArg(taskName);
  // Use forward-slash-safe result path and escape for cmd
  const quotedResultPath = quoteCmdScriptArg(resultPath);

  return [
    "@echo off",
    "setlocal enabledelayedexpansion",
    "",
    "REM === Phase 1: Wait for Gateway process to exit ===",
    "set /a waited=0",
    `:wait_pid`,
    `tasklist /FI "PID eq ${gatewayPid}" 2>nul | findstr /I "${gatewayPid}" >nul 2>&1`,
    `if errorlevel 1 goto pid_gone`,
    `timeout /t ${PID_POLL_INTERVAL_SEC} /nobreak >nul`,
    `set /a waited+=1`,
    `set /a maxPolls=${Math.ceil(PID_WAIT_TIMEOUT_SEC / PID_POLL_INTERVAL_SEC)}`,
    `if !waited! GEQ !maxPolls! (`,
    `  echo {"ok":false,"reason":"pid-wait-timeout"} > ${quotedResultPath}`,
    `  goto cleanup`,
    `)`,
    `goto wait_pid`,
    "",
    `:pid_gone`,
    "REM Brief pause to let file handles release",
    "timeout /t 2 /nobreak >nul",
    "",
    "REM === Phase 2: Run npm global install ===",
    `${installCommand}`,
    `set INSTALL_EXIT=!errorlevel!`,
    "",
    `if !INSTALL_EXIT! NEQ 0 (`,
    `  echo {"ok":false,"reason":"install-failed","exitCode":!INSTALL_EXIT!} > ${quotedResultPath}`,
    `  goto restart_gateway`,
    `)`,
    "",
    `echo {"ok":true,"reason":"install-succeeded"} > ${quotedResultPath}`,
    "",
    `:restart_gateway`,
    "REM === Phase 3: Restart Gateway via Scheduled Task ===",
    "set /a attempts=0",
    ":retry_restart",
    `timeout /t ${TASK_RESTART_RETRY_DELAY_SEC} /nobreak >nul`,
    "set /a attempts+=1",
    `schtasks /Run /TN ${quotedTaskName} >nul 2>&1`,
    "if not errorlevel 1 goto cleanup",
    `if !attempts! GEQ ${TASK_RESTART_RETRY_LIMIT} goto cleanup`,
    "goto retry_restart",
    "",
    ":cleanup",
    'del "%~f0" >nul 2>&1',
  ].join("\r\n");
}

/**
 * Spawn a detached batch script that will perform the npm global update
 * after the current Gateway process exits.
 *
 * @returns Result with paths to the script and the JSON result file.
 *          The caller should initiate a graceful Gateway shutdown after this call.
 */
export function spawnDetachedUpdate(params: {
  installArgv: string[];
  env?: NodeJS.ProcessEnv;
}): DetachedUpdateResult {
  const env = params.env ?? process.env;
  const tmpDir = resolvePreferredOpenClawTmpDir();
  const id = randomUUID();
  const scriptPath = path.join(tmpDir, `openclaw-detached-update-${id}.cmd`);
  const resultPath = path.join(tmpDir, `openclaw-detached-update-${id}.json`);
  const taskName = resolveWindowsTaskName(env);

  // Build the install command line with proper quoting
  const installCommand = params.installArgv
    .map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))
    .join(" ");

  const script = buildDetachedUpdateScript({
    gatewayPid: process.pid,
    installCommand,
    taskName,
    resultPath,
  });

  try {
    fs.writeFileSync(scriptPath, `${script}\r\n`, "utf8");
    const child = spawn("cmd.exe", ["/d", "/s", "/c", quoteCmdScriptArg(scriptPath)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return {
      ok: true,
      scriptPath,
      resultPath,
    };
  } catch (err) {
    // Clean up on failure
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // best-effort
    }
    return {
      ok: false,
      scriptPath,
      resultPath,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read the result JSON left by a previous detached update.
 * Returns null if the file doesn't exist or is unreadable.
 */
export function readDetachedUpdateResult(
  resultPath: string,
): { ok: boolean; reason?: string; exitCode?: number } | null {
  try {
    const raw = fs.readFileSync(resultPath, "utf8").trim();
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}
