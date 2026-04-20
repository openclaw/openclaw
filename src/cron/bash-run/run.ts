// bash-kind cron executor (feat/bash-kind).
//
// Spawns the configured command via `/bin/bash -c`, captures stdout with a
// size ceiling, enforces timeout, and returns the outcome in the same shape
// as the agent-turn runner so the scheduler/delivery layers can treat both
// paths uniformly.
//
// Intentionally minimal — maintainers should review sandbox/security posture
// before merging (see PR description).

import { spawn } from "node:child_process";
import type { CronJob, CronRunOutcome } from "../types.js";

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
const NO_REPLY_SENTINEL = "NO_REPLY";

export type RunCronBashResult = CronRunOutcome & {
  outputText?: string;
  stderrText?: string;
  exitCode?: number;
  timedOut?: boolean;
  /** `true` when stdout was exactly `NO_REPLY` — caller should skip delivery. */
  suppressDelivery?: boolean;
};

export async function runCronBashJob(params: {
  job: CronJob;
  abortSignal?: AbortSignal;
}): Promise<RunCronBashResult> {
  const { job, abortSignal } = params;
  if (job.payload.kind !== "bash") {
    return { status: "skipped", error: "bash job requires payload.kind=bash" };
  }
  const {
    command,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    cwd,
    env: extraEnv,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = job.payload;

  if (abortSignal?.aborted) {
    return { status: "error", error: "aborted before spawn" };
  }

  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...(extraEnv ?? {}) };

  return await new Promise<RunCronBashResult>((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
        // Escalate if the child ignores SIGTERM.
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 5000).unref();
      } catch {
        /* ignore */
      }
    }, Math.max(1, timeoutSeconds) * 1000);
    timer.unref();

    const onAbort = () => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        if (!truncated) {
          stdout += chunk.slice(0, maxOutputBytes - (stdoutBytes - chunk.length)).toString("utf8");
          stdout += "\n…[truncated]";
          truncated = true;
        }
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) return;
      stderr += chunk.toString("utf8");
    });

    const finalize = (exitCode: number | null, signalName: NodeJS.Signals | null) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);

      const trimmed = stdout.trim();
      const suppress = trimmed === NO_REPLY_SENTINEL || trimmed.length === 0;

      if (timedOut) {
        resolve({
          status: "error",
          error: `bash command timed out after ${timeoutSeconds}s`,
          outputText: stdout || undefined,
          stderrText: stderr || undefined,
          exitCode: exitCode ?? undefined,
          timedOut: true,
        });
        return;
      }

      if ((exitCode ?? 0) !== 0) {
        resolve({
          status: "error",
          error: `bash exited with code ${exitCode ?? signalName ?? "unknown"}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
          outputText: stdout || undefined,
          stderrText: stderr || undefined,
          exitCode: exitCode ?? undefined,
        });
        return;
      }

      resolve({
        status: "ok",
        summary: trimmed.split("\n").slice(0, 3).join(" | ").slice(0, 200),
        outputText: stdout || undefined,
        stderrText: stderr || undefined,
        exitCode: 0,
        suppressDelivery: suppress,
      });
    };

    child.on("error", (err) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve({
        status: "error",
        error: `failed to spawn bash: ${String(err)}`,
      });
    });

    child.on("exit", (code, signal) => {
      finalize(code, signal);
    });
  });
}
