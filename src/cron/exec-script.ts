// Authored by: cc (Claude Code) | 2026-03-15
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import type { CronRunOutcome, CronScriptPayload } from "./types.js";

export type ExecCronScriptParams = {
  payload: CronScriptPayload;
  /** OC home directory — used as base for relative script paths. */
  basePath: string;
  /** Abort signal for timeout enforcement. */
  abortSignal?: AbortSignal;
};

/**
 * Execute a cron script payload via child_process.execFile (no shell — no injection risk).
 * Returns stdout as `summary` on success, stderr as `error` on non-zero exit.
 */
export async function execCronScript(params: ExecCronScriptParams): Promise<CronRunOutcome> {
  const { payload, basePath, abortSignal } = params;

  if (abortSignal?.aborted) {
    return { status: "error", error: "script execution aborted (timeout)" };
  }

  if (!payload.command.trim()) {
    return { status: "error", error: "script command is empty" };
  }

  const resolvedCommand = resolveScriptPath(payload.command, basePath);

  // Validate file exists before spawning to give a clear error message.
  if (!fs.existsSync(resolvedCommand)) {
    return {
      status: "error",
      error: `script not found: ${resolvedCommand} (command: ${payload.command})`,
    };
  }

  const resolvedCwd = payload.cwd ? resolveScriptPath(payload.cwd, basePath) : basePath;
  if (payload.cwd && !fs.existsSync(resolvedCwd)) {
    return {
      status: "error",
      error: `script cwd not found: ${resolvedCwd} (cwd: ${payload.cwd})`,
    };
  }
  const childEnv = payload.env ? { ...process.env, ...payload.env } : process.env;

  // Detect interpreter from extension so scripts don't require chmod +x.
  // When no interpreter is found the file is executed directly (still needs +x).
  const interpreter = resolveScriptInterpreter(resolvedCommand);
  const execCmd = interpreter ?? resolvedCommand;
  const execArgs = interpreter ? [resolvedCommand, ...(payload.args ?? [])] : (payload.args ?? []);

  return new Promise<CronRunOutcome>((resolve) => {
    let settled = false;
    let aborted = false;
    const settle = (result: CronRunOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const child = execFile(
      execCmd,
      execArgs,
      { env: childEnv, cwd: resolvedCwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (aborted) {
          // Aborted via signal — report the abort reason regardless of the signal error.
          settle({ status: "error", error: "script execution aborted (timeout)" });
        } else if (err) {
          // Non-zero exit or spawn error — capture stderr as the error message.
          const errText = stderr?.trim() || err.message;
          settle({ status: "error", error: errText, summary: stdout?.trim() || undefined });
        } else {
          settle({ status: "ok", summary: stdout?.trim() || undefined });
        }
      },
    );

    if (abortSignal) {
      const onAbort = () => {
        if (settled) {
          return;
        }
        aborted = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // process may have already exited
        }
        // Escalate to SIGKILL after 5s if SIGTERM doesn't terminate the process.
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, 5_000);
        // Clear the timer once the process exits; execFile callback will settle.
        child.once("close", () => clearTimeout(killTimer));
      };
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
        child.once("close", () => {
          abortSignal.removeEventListener("abort", onAbort);
        });
      }
    }
  });
}

/**
 * Map a script file extension to an interpreter binary so scripts don't need
 * the executable bit set. Returns null for unknown extensions — caller falls
 * back to direct execution (which still requires chmod +x).
 *
 * Mapping is intentionally conservative: only unambiguous, widely-available
 * runtimes are covered. New entries should only be added when there is a single
 * obvious choice for the extension.
 */
function resolveScriptInterpreter(scriptPath: string): string | null {
  const ext = path.extname(scriptPath).toLowerCase();
  switch (ext) {
    case ".sh":
      return "sh";
    case ".bash":
      return "bash";
    case ".zsh":
      return "zsh";
    case ".js":
    case ".cjs":
    case ".mjs":
      return "node";
    case ".ts":
      // Uses bun for TypeScript. If bun is not installed the spawn will fail
      // with an error message. Users can ensure bun is available or use a shebang.
      return "bun";
    case ".py":
      return "python3";
    case ".rb":
      return "ruby";
    default:
      return null;
  }
}

/**
 * Resolve a script path: ~ is expanded to home, absolute paths pass through,
 * relative paths are resolved against basePath (OC home dir), not process.cwd().
 */
function resolveScriptPath(input: string, basePath: string): string {
  const trimmed = input.trim();
  // ~ prefix: let resolveUserPath expand it (always absolute after expansion).
  if (trimmed.startsWith("~")) {
    return resolveUserPath(trimmed);
  }
  // Already absolute: pass through.
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  // Relative: resolve against basePath so scripts in OC home work without full paths.
  return path.resolve(basePath, trimmed);
}
