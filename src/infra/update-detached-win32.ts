/**
 * Windows detached update helper.
 *
 * Windows keeps loaded Gateway files locked, so the live process cannot safely
 * swap a verified staged npm package into its own global package root. This
 * module writes a short-lived `.cmd` launcher plus a standalone Node.js swap
 * script. The launcher waits for the Gateway PID to exit, runs the swap script,
 * restarts the Gateway through the Windows Scheduled Task handoff, and records
 * the outcome for the next Gateway boot.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { quoteCmdScriptArg } from "../daemon/cmd-argv.js";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { resolveGatewayStateDir } from "../daemon/paths.js";
import { renderCmdRestartLogSetup } from "../daemon/restart-logs.js";
import type { StagedNpmInstall } from "./package-update-steps.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import {
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

const PID_WAIT_TIMEOUT_SEC = 60;
const PID_POLL_INTERVAL_SEC = 2;
const TASK_RESTART_RETRY_LIMIT = 12;
const TASK_RESTART_RETRY_DELAY_SEC = 1;

export {
  readDetachedUpdateResult,
  removeDetachedUpdateResult,
  type DetachedUpdateRecordedResult,
} from "./update-detached-result.js";

export type DetachedUpdateResult = {
  ok: boolean;
  scriptPath: string;
  resultPath: string;
  nodeScriptPath: string;
  detail?: string;
};

function resolveWindowsTaskName(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

function resolveTaskScriptPath(env: NodeJS.ProcessEnv): string | undefined {
  const override = env.OPENCLAW_TASK_SCRIPT?.trim();
  if (override) {
    return override;
  }
  try {
    const scriptName = env.OPENCLAW_TASK_SCRIPT_NAME?.trim() || "gateway.cmd";
    return path.join(resolveGatewayStateDir(env), scriptName);
  } catch {
    return undefined;
  }
}

function normalizePackageName(value: string): string {
  const trimmed = value.trim();
  return trimmed || "openclaw";
}

function buildDetachedSwapNodeScript(params: {
  stage: StagedNpmInstall;
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  resultPath: string;
  afterVersion?: string | null;
}): string {
  const packageName = normalizePackageName(params.packageName);
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot);
  const meta = {
    stagePrefix: params.stage.prefix,
    stagePackageRoot: params.stage.packageRoot,
    stageBinDir: params.stage.layout.binDir,
    targetGlobalRoot: params.installTarget.globalRoot,
    targetPackageRoot: params.installTarget.packageRoot,
    targetBinDir: targetLayout?.binDir ?? null,
    packageName,
    resultPath: params.resultPath,
    afterVersion: params.afterVersion ?? null,
  };

  return String.raw`const fs = require("node:fs/promises");
const path = require("node:path");

const meta = ${JSON.stringify(meta)};

function formatError(err) {
  return err && typeof err === "object" && typeof err.message === "string"
    ? err.message
    : String(err);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeResult(result) {
  await fs.writeFile(meta.resultPath, JSON.stringify(result), "utf8");
}

async function copyPathEntry(source, destination) {
  const stat = await fs.lstat(source);
  await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    await fs.cp(source, destination, {
      recursive: true,
      force: true,
      preserveTimestamps: false,
    });
    return;
  }
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode).catch(() => undefined);
}

async function restoreNpmBinShimBackup(backup) {
  await fs.mkdir(backup.targetBinDir, { recursive: true });
  for (const entry of backup.entries) {
    const destination = path.join(backup.targetBinDir, entry.name);
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    if (entry.hadExisting) {
      await copyPathEntry(path.join(backup.backupDir, entry.name), destination);
    }
  }
}

async function replaceNpmBinShims() {
  let entries = [];
  try {
    entries = await fs.readdir(meta.stageBinDir);
  } catch {
    return;
  }
  const names = new Set([meta.packageName, "openclaw"]);
  const shimEntries = entries.filter((entry) => {
    const parsed = path.parse(entry);
    return names.has(entry) || names.has(parsed.name);
  });
  if (shimEntries.length === 0) {
    return;
  }

  const backup = {
    backupDir: await fs.mkdtemp(path.join(meta.targetGlobalRoot, ".openclaw-shim-backup-")),
    targetBinDir: meta.targetBinDir,
    entries: [],
  };
  try {
    await fs.mkdir(meta.targetBinDir, { recursive: true });
    for (const entry of shimEntries) {
      const destination = path.join(meta.targetBinDir, entry);
      const hadExisting = await pathExists(destination);
      backup.entries.push({ name: entry, hadExisting });
      if (hadExisting) {
        await copyPathEntry(destination, path.join(backup.backupDir, entry));
      }
    }
    for (const entry of shimEntries) {
      await copyPathEntry(path.join(meta.stageBinDir, entry), path.join(meta.targetBinDir, entry));
    }
  } catch (err) {
    await restoreNpmBinShimBackup(backup);
    throw err;
  } finally {
    await fs.rm(backup.backupDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function run() {
  if (!meta.targetGlobalRoot || !meta.targetPackageRoot || !meta.targetBinDir) {
    await writeResult({ ok: false, reason: "swap-failed", detail: "cannot resolve npm global prefix layout" });
    process.exitCode = 1;
    return;
  }

  const backupRoot = path.join(meta.targetGlobalRoot, ".openclaw-" + process.pid + "-" + Date.now());
  let movedExisting = false;
  let movedStaged = false;
  try {
    await fs.mkdir(meta.targetGlobalRoot, { recursive: true });
    if (await pathExists(meta.targetPackageRoot)) {
      await fs.rename(meta.targetPackageRoot, backupRoot);
      movedExisting = true;
    }
    await fs.rename(meta.stagePackageRoot, meta.targetPackageRoot);
    movedStaged = true;
    await replaceNpmBinShims();
    if (movedExisting) {
      await fs.rm(backupRoot, { recursive: true, force: true });
    }
    await writeResult({ ok: true, reason: "install-succeeded", afterVersion: meta.afterVersion });
  } catch (err) {
    if (movedStaged) {
      await fs.rm(meta.targetPackageRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (movedExisting) {
      await fs.rename(backupRoot, meta.targetPackageRoot).catch(() => undefined);
    }
    await writeResult({ ok: false, reason: "swap-failed", detail: formatError(err) });
    process.exitCode = 1;
  } finally {
    await fs.rm(meta.stagePrefix, { recursive: true, force: true }).catch(() => undefined);
  }
}

run().catch(async (err) => {
  await writeResult({ ok: false, reason: "swap-failed", detail: formatError(err) }).catch(() => undefined);
  process.exitCode = 1;
});
`;
}

function buildDetachedUpdateLauncher(params: {
  gatewayPid: number;
  nodeCommand: string;
  nodeScriptPath: string;
  taskName: string;
  taskScriptPath?: string;
  resultPath: string;
  setupLines: string[];
  quotedLogPath: string;
}): string {
  const quotedTaskName = quoteCmdScriptArg(params.taskName);
  const quotedResultPath = quoteCmdScriptArg(params.resultPath);
  const quotedTaskScriptPath = params.taskScriptPath
    ? quoteCmdScriptArg(params.taskScriptPath)
    : null;
  const nodeInvocation = `${quoteCmdScriptArg(params.nodeCommand)} ${quoteCmdScriptArg(params.nodeScriptPath)}`;

  const lines = [
    "@echo off",
    "setlocal enabledelayedexpansion",
    ...params.setupLines,
    `>> ${params.quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw detached update started target=${quotedTaskName}`,
    "",
    "set /a waited=0",
    ":wait_pid",
    `tasklist /FI "PID eq ${params.gatewayPid}" 2>nul | findstr /I "${params.gatewayPid}" >nul 2>&1`,
    "if errorlevel 1 goto pid_gone",
    `timeout /t ${PID_POLL_INTERVAL_SEC} /nobreak >nul`,
    "set /a waited+=1",
    `set /a maxPolls=${Math.ceil(PID_WAIT_TIMEOUT_SEC / PID_POLL_INTERVAL_SEC)}`,
    "if !waited! GEQ !maxPolls! (",
    `  >> ${params.quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw detached update pid wait timeout`,
    `  echo {"ok":false,"reason":"pid-wait-timeout"} > ${quotedResultPath}`,
    "  goto cleanup",
    ")",
    "goto wait_pid",
    "",
    ":pid_gone",
    "timeout /t 2 /nobreak >nul",
    `>> ${params.quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw detached update swapping staged package`,
    `${nodeInvocation} >> ${params.quotedLogPath} 2>&1`,
    "set SWAP_EXIT=!errorlevel!",
    "if !SWAP_EXIT! NEQ 0 (",
    `  >> ${params.quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw detached update swap failed status=!SWAP_EXIT!`,
    `  if not exist ${quotedResultPath} echo {"ok":false,"reason":"swap-failed","exitCode":!SWAP_EXIT!} > ${quotedResultPath}`,
    "  goto restart_gateway",
    ")",
    "set SWAP_OK=1",
    "",
    ":restart_gateway",
    "set /a attempts=0",
    ":retry_restart",
    `timeout /t ${TASK_RESTART_RETRY_DELAY_SEC} /nobreak >nul`,
    "set /a attempts+=1",
    `schtasks /Run /TN ${quotedTaskName} >nul 2>&1`,
    "if not errorlevel 1 goto restart_succeeded",
    `if !attempts! GEQ ${TASK_RESTART_RETRY_LIMIT} goto restart_fallback`,
    "goto retry_restart",
    "",
    ":restart_fallback",
  ];

  if (quotedTaskScriptPath) {
    lines.push(
      `>> ${params.quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw detached update schtasks failed, trying task script fallback`,
      `if exist ${quotedTaskScriptPath} (`,
      `  start "" /min cmd.exe /d /c ${quotedTaskScriptPath}`,
      "  if not errorlevel 1 goto restart_succeeded",
      ")",
    );
  }

  lines.push(
    `>> ${params.quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw detached update restart failed`,
    `if "%SWAP_OK%"=="1" echo {"ok":false,"reason":"restart-failed"} > ${quotedResultPath}`,
    "goto cleanup",
    "",
    ":restart_succeeded",
    `>> ${params.quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw detached update restart dispatched`,
    "",
    ":cleanup",
    `del ${quoteCmdScriptArg(params.nodeScriptPath)} >nul 2>&1`,
    'del "%~f0" >nul 2>&1',
  );
  return lines.join("\r\n");
}

export function spawnDetachedUpdate(params: {
  stage: StagedNpmInstall;
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  afterVersion?: string | null;
  env?: NodeJS.ProcessEnv;
}): DetachedUpdateResult {
  const env = params.env ?? process.env;
  const tmpDir = resolvePreferredOpenClawTmpDir();
  const id = randomUUID();
  const scriptPath = path.join(tmpDir, `openclaw-detached-update-${id}.cmd`);
  const nodeScriptPath = path.join(tmpDir, `openclaw-detached-update-${id}.cjs`);
  const resultPath = path.join(tmpDir, `openclaw-detached-update-${id}.json`);
  const restartLog = renderCmdRestartLogSetup({ ...process.env, ...env });

  const nodeScript = buildDetachedSwapNodeScript({
    stage: params.stage,
    installTarget: params.installTarget,
    packageName: params.packageName,
    afterVersion: params.afterVersion,
    resultPath,
  });
  const launcher = buildDetachedUpdateLauncher({
    gatewayPid: process.pid,
    nodeCommand: process.execPath,
    nodeScriptPath,
    taskName: resolveWindowsTaskName(env),
    taskScriptPath: resolveTaskScriptPath(env),
    resultPath,
    setupLines: restartLog.lines,
    quotedLogPath: restartLog.quotedLogPath,
  });

  try {
    fs.writeFileSync(nodeScriptPath, nodeScript, "utf8");
    fs.writeFileSync(scriptPath, `${launcher}\r\n`, "utf8");
    const child = spawn("cmd.exe", ["/d", "/s", "/c", quoteCmdScriptArg(scriptPath)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    child.unref();
    return { ok: true, scriptPath, nodeScriptPath, resultPath };
  } catch (err) {
    for (const filePath of [scriptPath, nodeScriptPath]) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // best-effort
      }
    }
    return {
      ok: false,
      scriptPath,
      nodeScriptPath,
      resultPath,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
