import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import { join, dirname, basename } from "node:path";

export interface AgentProcessConfig {
  teamName: string;
  memberName: string;
  role: string;
  notifyPort: number;
  configPath: string;
}

/**
 * Spawns a headless OpenClaw worker process for agent team coordination.
 *
 * The worker process is spawned using the same Node.js binary and CLI entry
 * point as the current process (`process.execPath` + `process.argv[1]`), so
 * it works correctly regardless of how OpenClaw was launched (npx, pnpm, direct
 * node invocation, etc.).
 *
 * The worker inherits the caller's environment (API keys, model config, auth)
 * and receives team context via the following environment variables:
 *
 *   OPENCLAW_TEAM_NAME      - team identifier
 *   OPENCLAW_MEMBER_NAME    - member/worker identifier
 *   OPENCLAW_ROLE           - member role (e.g. "researcher", "writer")
 *   OPENCLAW_CONFIG_PATH    - path to team config.json
 *   OPENCLAW_NOTIFY_PORT    - local HTTP port for receiving notifications
 *
 * Used by the openclaw-teams plugin. Designed as a generic hook so other
 * plugins can also spawn isolated agent processes.
 */
export function spawnAgentProcess(config: AgentProcessConfig): ChildProcess {
  // Validate memberName to prevent path traversal (e.g. "../../../etc/passwd")
  if (!config.memberName || /[/\\]/.test(config.memberName)) {
    throw new Error(
      `Invalid memberName: ${JSON.stringify(config.memberName)} — must not contain path separators`,
    );
  }

  const logDir = join(dirname(config.configPath), "logs");
  mkdirSync(logDir, { recursive: true });

  // Spawn using the same Node binary + CLI entry path as the running process,
  // so the worker works in all environments (npx, pnpm, direct node, etc.)
  const cliEntryPath = process.argv[1] ?? "";
  const child = spawn(process.execPath, [cliEntryPath, "--mode=worker"], {
    env: {
      ...process.env,
      OPENCLAW_TEAM_NAME: config.teamName,
      OPENCLAW_MEMBER_NAME: config.memberName,
      OPENCLAW_ROLE: config.role,
      OPENCLAW_CONFIG_PATH: config.configPath,
      OPENCLAW_NOTIFY_PORT: String(config.notifyPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Capture stdout/stderr to per-member log files.
  // Attach error handlers to prevent unhandled error events from crashing the
  // parent process if the log directory becomes unavailable (disk full, etc.)
  const stdoutLog = createWriteStream(join(logDir, `${config.memberName}.log`), { flags: "a" });
  const stderrLog = createWriteStream(join(logDir, `${config.memberName}.err`), { flags: "a" });
  stdoutLog.on("error", () => {
    /* log write failures are non-fatal */
  });
  stderrLog.on("error", () => {
    /* log write failures are non-fatal */
  });

  child.stdout?.pipe(stdoutLog);
  child.stderr?.pipe(stderrLog);

  return child;
}
