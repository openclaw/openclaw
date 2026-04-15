import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PreHookConfig = {
  command: string;
  timeoutSeconds?: number;
};

export type PreHookResult = {
  outcome: "proceed" | "skip" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

/** Exit code that signals a clean skip (not counted as a failure). */
const SKIP_EXIT_CODE = 10;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 64 * 1024;

function resolveShell(): { shell: string; flag: string } {
  return process.platform === "win32"
    ? { shell: "cmd.exe", flag: "/c" }
    : { shell: "/bin/sh", flag: "-c" };
}

function clampTimeout(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds == null || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(timeoutSeconds * 1_000, MAX_TIMEOUT_MS);
}

export async function runPreHook(
  hook: PreHookConfig,
  abortSignal?: AbortSignal,
): Promise<PreHookResult> {
  if (abortSignal?.aborted) {
    return { outcome: "error", exitCode: null, stdout: "", stderr: "", error: "aborted" };
  }

  const { shell, flag } = resolveShell();
  const timeoutMs = clampTimeout(hook.timeoutSeconds);

  try {
    const { stdout, stderr } = await execFileAsync(shell, [flag, hook.command], {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      signal: abortSignal,
    });
    return { outcome: "proceed", exitCode: 0, stdout, stderr };
  } catch (err: unknown) {
    const execErr = err as {
      code?: string | number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };

    const stdout = typeof execErr.stdout === "string" ? execErr.stdout : "";
    const stderr = typeof execErr.stderr === "string" ? execErr.stderr : "";

    // Abort signal fired
    if (execErr.code === "ABORT_ERR" || abortSignal?.aborted) {
      return { outcome: "error", exitCode: null, stdout, stderr, error: "aborted" };
    }

    // Timeout (child killed by Node)
    if (execErr.killed) {
      return {
        outcome: "error",
        exitCode: null,
        stdout,
        stderr,
        error: `preHook timed out after ${timeoutMs}ms`,
      };
    }

    // maxBuffer exceeded — treat as error, never skip (review fix #1)
    if (execErr.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return {
        outcome: "error",
        exitCode: null,
        stdout,
        stderr,
        error: "preHook exceeded output buffer limit",
      };
    }

    // execFile sets .code to the numeric exit code for non-zero exits
    const exitCode = typeof execErr.code === "number" ? execErr.code : null;

    // Unknown exit status — error
    if (exitCode == null) {
      return {
        outcome: "error",
        exitCode: null,
        stdout,
        stderr,
        error: "preHook exited with unknown status",
      };
    }

    // Exit 10 = skip
    if (exitCode === SKIP_EXIT_CODE) {
      return { outcome: "skip", exitCode, stdout, stderr };
    }

    // Any other non-zero = error
    return {
      outcome: "error",
      exitCode,
      stdout,
      stderr,
      error: `preHook failed with exit code ${exitCode}`,
    };
  }
}
