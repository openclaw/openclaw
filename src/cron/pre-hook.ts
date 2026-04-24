import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSensitiveText } from "../logging/redact.js";

const execFileAsync = promisify(execFile);

/** Max chars of stdout/stderr surfaced into logs. Keeps log volume bounded and limits secret leakage. */
const LOG_OUTPUT_MAX_CHARS = 512;

/**
 * Redact and truncate a preHook output stream before logging. Callers must use
 * this helper rather than logging raw `result.stdout` / `result.stderr`, since
 * hook scripts may print tokens, credentials, or other sensitive data.
 */
export function summarizePreHookOutput(text: string): string {
  if (!text) {
    return text;
  }
  const redacted = redactSensitiveText(text, { mode: "tools" });
  if (redacted.length <= LOG_OUTPUT_MAX_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, LOG_OUTPUT_MAX_CHARS)}… [+${redacted.length - LOG_OUTPUT_MAX_CHARS} chars truncated]`;
}

export type PreHookConfig = {
  file: string;
  args?: readonly string[];
  timeoutSeconds?: number;
};

export type PreHookResult = {
  outcome: "proceed" | "skip" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

const SKIP_EXIT_CODE = 10;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 64 * 1024;

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

  const timeoutMs = clampTimeout(hook.timeoutSeconds);
  const args = hook.args ? [...hook.args] : [];

  try {
    // Executed without a shell: metacharacters in `file`/`args` are literal.
    const { stdout, stderr } = await execFileAsync(hook.file, args, {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      signal: abortSignal,
      shell: false,
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

    if (execErr.code === "ABORT_ERR" || abortSignal?.aborted) {
      return { outcome: "error", exitCode: null, stdout, stderr, error: "aborted" };
    }

    if (execErr.killed) {
      return {
        outcome: "error",
        exitCode: null,
        stdout,
        stderr,
        error: `preHook timed out after ${timeoutMs}ms`,
      };
    }

    if (execErr.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return {
        outcome: "error",
        exitCode: null,
        stdout,
        stderr,
        error: "preHook exceeded output buffer limit",
      };
    }

    if (execErr.code === "ENOENT") {
      return {
        outcome: "error",
        exitCode: null,
        stdout,
        stderr,
        error: `preHook file not found: ${hook.file}`,
      };
    }

    const exitCode = typeof execErr.code === "number" ? execErr.code : null;

    if (exitCode == null) {
      return {
        outcome: "error",
        exitCode: null,
        stdout,
        stderr,
        error: "preHook exited with unknown status",
      };
    }

    if (exitCode === SKIP_EXIT_CODE) {
      return { outcome: "skip", exitCode, stdout, stderr };
    }

    return {
      outcome: "error",
      exitCode,
      stdout,
      stderr,
      error: `preHook failed with exit code ${exitCode}`,
    };
  }
}
