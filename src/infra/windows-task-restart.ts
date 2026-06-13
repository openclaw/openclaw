// Relaunches the gateway through the managed Windows scheduled task.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { renderCmdRestartLogSetup } from "../daemon/restart-logs.js";
import { resolveTaskScriptPath } from "../daemon/schtasks.js";
import { formatErrorMessage } from "./errors.js";
import type { RestartAttempt } from "./restart.types.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const TASK_STOP_WAIT_ATTEMPTS = 15;
const TASK_STOP_WAIT_INTERVAL_MS = 2_000;

function resolveWindowsTaskName(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

/**
 * Launch a Node.js subprocess that waits for the old gateway to stop, then
 * starts the scheduled task. This avoids the cmd.exe handoff script which:
 * 1) Shows visible console windows (powershell | findstr)
 * 2) Has a race condition: "Running" status after gateway exit causes premature cleanup
 *
 * The subprocess is detached and self-managing — it exits once the new gateway
 * is launched or all retries are exhausted.
 */
function buildNodeHandoffLauncher(params: {
  logPath: string;
  taskName: string;
  taskScriptPath?: string;
}): string {
  const { logPath, taskName, taskScriptPath } = params;
  return `import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const logPath = ${JSON.stringify(logPath)};
const taskName = ${JSON.stringify(taskName)};
const taskScriptPath = ${JSON.stringify(taskScriptPath ?? "")};

function log(message) {
  try {
    fs.appendFileSync(logPath, new Date().toISOString() + " " + message + "\\n");
  } catch {
    // Best-effort diagnostic logging for a detached restart helper.
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let stopped = false;
log("openclaw restart attempt source=node-handoff target=" + taskName);

for (let attempt = 0; attempt < ${TASK_STOP_WAIT_ATTEMPTS}; attempt += 1) {
  const result = spawnSync("schtasks", ["/Query", "/TN", taskName, "/FO", "LIST", "/V"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  const output = (result.stdout || "").toLowerCase();
  if (result.status !== 0 || !output.includes("running")) {
    stopped = true;
    break;
  }
  sleep(${TASK_STOP_WAIT_INTERVAL_MS});
}

if (!stopped) {
  log("task still running, force killing gateway listener");
  const netstat = spawnSync("netstat", ["-aon"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  for (const line of (netstat.stdout || "").split("\\n")) {
    if (!line.includes(":18789") || !line.includes("LISTENING")) {
      continue;
    }
    const parts = line.trim().split(/\\s+/);
    const pid = parts[parts.length - 1];
    if (pid && /^\\d+$/.test(pid)) {
      spawnSync("taskkill", ["/F", "/PID", pid], { windowsHide: true });
    }
  }
  sleep(5_000);
}

log("launching task via schtasks /Run");
const run = spawnSync("schtasks", ["/Run", "/TN", taskName], {
  encoding: "utf8",
  timeout: 10_000,
  windowsHide: true,
});
log("schtasks /Run exit=" + run.status + " out=" + (run.stdout || "").trim());

if (run.status !== 0 && taskScriptPath && fs.existsSync(taskScriptPath)) {
  log("schtasks /Run failed, trying fallback");
  const fallback = spawn("cmd.exe", ["/d", "/s", "/c", taskScriptPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  fallback.unref();
  log("fallback launched: " + taskScriptPath);
}

log("openclaw restart finished source=node-handoff");
`;
}

export function relaunchGatewayScheduledTask(env: NodeJS.ProcessEnv = process.env): RestartAttempt {
  const taskName = resolveWindowsTaskName(env);
  const taskScriptPath = resolveTaskScriptPath(env);
  const scriptPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-node-restart-${randomUUID()}.mjs`,
  );
  const restartLog = renderCmdRestartLogSetup({ ...process.env, ...env });
  const logPath = restartLog.quotedLogPath.replace(/^"|"$/g, "");

  try {
    fs.writeFileSync(
      scriptPath,
      buildNodeHandoffLauncher({ logPath, taskName, taskScriptPath }),
      "utf8",
    );
    const endChild = spawn(
      "cmd.exe",
      ["/d", "/s", "/c", `schtasks /End /TN "${taskName}"`],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    endChild.unref();

    const launcher = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    launcher.unref();

    return {
      ok: true,
      method: "schtasks",
      tried: [`node ${scriptPath}`, `schtasks /End /TN "${taskName}"`],
    };
  } catch (err) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup for a helper script that may not have been written.
    }
    return {
      ok: false,
      method: "schtasks",
      detail: formatErrorMessage(err),
      tried: [`node ${scriptPath}`],
    };
  }
}
