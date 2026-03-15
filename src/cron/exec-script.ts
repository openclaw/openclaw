// Authored by: cc (Claude Code) | 2026-03-15
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import type { CronRunOutcome } from "./types.js";
import type { CronScriptPayload } from "./types.js";

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

  const resolvedCommand = resolveScriptPath(payload.command, basePath);

  // Validate file exists before spawning to give a clear error message.
  if (!fs.existsSync(resolvedCommand)) {
    return {
      status: "error",
      error: `script not found: ${resolvedCommand} (command: ${payload.command})`,
    };
  }

  const resolvedCwd = payload.cwd ? resolveScriptPath(payload.cwd, basePath) : basePath;
  const childEnv = payload.env ? { ...process.env, ...payload.env } : process.env;

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
      resolvedCommand,
      payload.args ?? [],
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
