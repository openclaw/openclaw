import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  type ControlPlaneUpdateSentinelMetaFile,
} from "../../infra/update-control-plane-sentinel.js";
import { MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "../../infra/update-managed-service-handoff-cleanup.js";
import type { UpdateRestartSentinelMeta } from "../../infra/update-restart-sentinel-payload.js";

const PARENT_EXIT_GRACE_MS = 60_000;

const HANDOFF_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const params = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(params.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(params.logPath, "[" + new Date().toISOString() + "] " + line + "\n", {
      mode: 0o600,
    });
  } catch {
    // Best effort only.
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupSensitiveFiles() {
  for (const filePath of params.sensitivePaths || []) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort only.
    }
  }
}

(async () => {
  const deadline = Date.now() + params.parentExitTimeoutMs;
  while (isPidAlive(params.parentPid) && Date.now() < deadline) {
    await sleep(250);
  }
  if (isPidAlive(params.parentPid)) {
    appendLog("gateway parent pid " + params.parentPid + " did not exit before handoff timeout");
    cleanupSensitiveFiles();
    process.exitCode = 1;
    return;
  }

  appendLog("starting managed update command: " + params.commandLabel);
  let outputFd;
  try {
    outputFd = fs.openSync(params.logPath, "a", 0o600);
    const child = spawn(params.commandArgv[0], params.commandArgv.slice(1), {
      cwd: params.cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
    });
    appendLog("managed update command pid=" + (child.pid || "unknown"));
    const exit = await new Promise((resolve) => {
      child.once("error", (err) => resolve({ error: err }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (exit && exit.error) {
      appendLog("managed update command failed to start: " + (exit.error && exit.error.stack ? exit.error.stack : String(exit.error)));
      process.exitCode = 1;
      return;
    }
    appendLog(
      "managed update command exited code=" +
        (exit && exit.code !== null && exit.code !== undefined ? exit.code : "null") +
        " signal=" +
        (exit && exit.signal ? exit.signal : "null"),
    );
    if (exit && typeof exit.code === "number" && exit.code !== 0) {
      process.exitCode = exit.code;
    } else if (exit && exit.signal) {
      process.exitCode = 1;
    }
  } finally {
    if (outputFd !== undefined) {
      try {
        fs.closeSync(outputFd);
      } catch {
        // Ignore close failures.
      }
    }
    cleanupSensitiveFiles();
  }
})().catch((err) => {
  appendLog("handoff failed: " + (err && err.stack ? err.stack : String(err)));
  cleanupSensitiveFiles();
  process.exitCode = 1;
});
`;

export type ManagedServiceUpdateHandoffResult = {
  status: "started";
  pid?: number;
  command: string;
  logPath: string;
};

function isNodeLikeRuntime(execPath: string | undefined): boolean {
  if (!execPath?.trim()) {
    return false;
  }
  const base = path.basename(execPath).toLowerCase();
  return base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe";
}

function resolveUpdateCliArgv(params: {
  timeoutMs?: number;
  execPath?: string;
  argv1?: string;
}): string[] {
  const updateArgs = ["update", "--yes", "--json"];
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    updateArgs.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1000))));
  }

  const execPath = params.execPath?.trim();
  const argv1 = params.argv1?.trim();
  if (execPath && argv1) {
    return [execPath, argv1, ...updateArgs];
  }
  if (execPath && !isNodeLikeRuntime(execPath)) {
    return [execPath, ...updateArgs];
  }
  return ["openclaw", ...updateArgs];
}

export function formatManagedServiceUpdateCommand(timeoutMs?: number): string {
  const args = ["openclaw", "update", "--yes"];
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
    args.push("--timeout", String(Math.max(1, Math.ceil(timeoutMs / 1000))));
  }
  return args.join(" ");
}

export function stripSupervisorHintEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    delete next[key];
  }
  return next;
}

export async function startManagedServiceUpdateHandoff(params: {
  root: string;
  timeoutMs?: number;
  restartDelayMs?: number;
  meta: UpdateRestartSentinelMeta;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  argv1?: string;
  parentPid?: number;
}): Promise<ManagedServiceUpdateHandoffResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX));
  const scriptPath = path.join(dir, "handoff.cjs");
  const paramsPath = path.join(dir, "handoff.json");
  const metaPath = path.join(dir, "sentinel-meta.json");
  const logPath = path.join(dir, "handoff.log");
  const commandArgv = resolveUpdateCliArgv({
    timeoutMs: params.timeoutMs,
    execPath: params.execPath ?? process.execPath,
    argv1: params.argv1 ?? process.argv[1],
  });
  const commandLabel = formatManagedServiceUpdateCommand(params.timeoutMs);
  const metaFile: ControlPlaneUpdateSentinelMetaFile = {
    version: 1,
    meta: params.meta,
  };
  const helperParams = {
    parentPid: params.parentPid ?? process.pid,
    parentExitTimeoutMs: Math.max(0, params.restartDelayMs ?? 0) + PARENT_EXIT_GRACE_MS,
    cwd: params.root,
    commandArgv,
    commandLabel,
    logPath,
    sensitivePaths: [scriptPath, paramsPath, metaPath],
  };

  await fs.writeFile(scriptPath, `${HANDOFF_SCRIPT}\n`, { mode: 0o700 });
  await fs.writeFile(paramsPath, `${JSON.stringify(helperParams, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(metaPath, `${JSON.stringify(metaFile, null, 2)}\n`, { mode: 0o600 });

  const env = {
    ...stripSupervisorHintEnv(params.env ?? process.env),
    [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
    OPENCLAW_UPDATE_RUN_HANDOFF: "1",
  };
  const child = spawn(params.execPath ?? process.execPath, [scriptPath, paramsPath], {
    cwd: params.root,
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return {
    status: "started",
    ...(child.pid ? { pid: child.pid } : {}),
    command: commandLabel,
    logPath,
  };
}

export function buildManagedServiceHandoffUnavailableMessage(command: string): string {
  return [
    "Package updates cannot safely run inside the live gateway process.",
    `Run \`${command}\` from a shell outside the gateway service, or restart/update from the host control plane.`,
  ].join("\n");
}
