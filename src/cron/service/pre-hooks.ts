import { spawn } from "node:child_process";
import type { CronPreHook } from "../types-shared.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export type PreHookResult = { proceed: true } | { proceed: false; reason: string };

type PreHookLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

/**
 * Run all pre-hooks sequentially.  The first hook that exits non-zero (or
 * times out) short-circuits and returns `{ proceed: false }`.
 */
export async function runPreHooks(params: {
  hooks: CronPreHook[];
  jobId: string;
  jobName: string;
  schedule: unknown;
  log: PreHookLogger;
}): Promise<PreHookResult> {
  for (const hook of params.hooks) {
    if (hook.kind === "shell") {
      const result = await runShellHook({
        command: hook.command,
        timeoutMs: hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        stdin: JSON.stringify({
          jobId: params.jobId,
          jobName: params.jobName,
          schedule: params.schedule,
        }),
        log: params.log,
      });
      if (!result.proceed) {
        return result;
      }
    }
  }
  return { proceed: true };
}

/**
 * Execute a single shell hook command.  The command is spawned via the
 * platform shell (`/bin/sh -c` on Unix, `cmd.exe /c` on Windows) so that
 * inline pipes and redirects work.  Job metadata is piped to stdin as JSON.
 */
export async function runShellHook(params: {
  command: string;
  timeoutMs: number;
  stdin: string;
  log: PreHookLogger;
}): Promise<PreHookResult> {
  const { command, timeoutMs, stdin, log } = params;

  return new Promise<PreHookResult>((resolve) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
    const shellArgs = isWindows ? ["/c", command] : ["-c", command];

    let settled = false;
    let timedOut = false;

    const child = spawn(shell, shellArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    // Pipe job metadata to the hook's stdin.
    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const reason = `shell hook error: ${err.message}`;
      log.warn({ command }, `cron: pre-hook failed: ${reason}`);
      resolve({ proceed: false, reason });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        const reason = `shell hook timed out after ${timeoutMs}ms`;
        log.warn({ command, timeoutMs }, `cron: pre-hook timed out`);
        resolve({ proceed: false, reason });
        return;
      }

      if (code === 0) {
        resolve({ proceed: true });
        return;
      }

      const trimmedStderr = stderr.trim().slice(0, 200);
      const reason = trimmedStderr
        ? `shell hook exited ${code}: ${trimmedStderr}`
        : `shell hook exited ${code}`;
      log.info({ command, exitCode: code }, `cron: pre-hook skipped job`);
      resolve({ proceed: false, reason });
    });
  });
}
