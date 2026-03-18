import { execFile } from "node:child_process";
import { platform } from "node:os";

export type PreHookConfig = {
  command: string;
  timeoutSeconds?: number;
};

export type PreHookResult =
  | { outcome: "proceed" }
  | { outcome: "skip"; stdout: string; stderr: string }
  | { outcome: "error"; exitCode: number; stdout: string; stderr: string; message: string };

export const PRE_HOOK_SKIP_EXIT_CODE = 10;
export const DEFAULT_PRE_HOOK_TIMEOUT_SECONDS = 30;
export const MAX_PRE_HOOK_TIMEOUT_SECONDS = 300;
const MAX_OUTPUT_BYTES = 64 * 1024;

export async function runPreHook(
  config: PreHookConfig,
  abortSignal?: AbortSignal,
): Promise<PreHookResult> {
  const timeoutMs =
    Math.min(
      config.timeoutSeconds ?? DEFAULT_PRE_HOOK_TIMEOUT_SECONDS,
      MAX_PRE_HOOK_TIMEOUT_SECONDS,
    ) * 1000;

  const isWindows = platform() === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["/c", config.command] : ["-c", config.command];

  return new Promise<PreHookResult>((resolve) => {
    const child = execFile(
      shell,
      shellArgs,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        cleanup();

        if (!error) {
          resolve({ outcome: "proceed" });
          return;
        }

        const isMaxBuffer =
          (error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

        // When maxBuffer is exceeded, the exit code may still be available via
        // error.status (Node.js populates it when the process has already exited).
        // If the process exited 0 (success), treat as "proceed" despite the truncated
        // output — verbose commands that succeed shouldn't block scheduled runs.
        if (isMaxBuffer) {
          const mbStatus = (error as NodeJS.ErrnoException & { status?: number }).status;
          if (mbStatus === 0) {
            resolve({ outcome: "proceed" });
            return;
          }
          // On Node 22, error.status may be undefined regardless of actual exit
          // code when maxBuffer fires. Default to "skip" (conservative) — we
          // can't verify the hook passed, so don't run the job.
          if (mbStatus === undefined) {
            resolve({
              outcome: "skip",
              stdout: String(stdout),
              stderr: String(stderr),
            });
            return;
          }
          if (mbStatus === PRE_HOOK_SKIP_EXIT_CODE) {
            resolve({
              outcome: "skip",
              stdout: String(stdout),
              stderr: String(stderr),
            });
            return;
          }
          resolve({
            outcome: "error",
            exitCode: mbStatus,
            stdout: String(stdout),
            stderr: String(stderr),
            message: "preHook output exceeded maxBuffer (64 KB)",
          });
          return;
        }

        // child_process.ExecException: error.code is a string (e.g. "ERR_..."),
        // the numeric exit code is in error.status (available on both Unix and Windows).
        const exitCode = (error as NodeJS.ErrnoException & { status?: number }).status ?? 1;

        if (error.killed) {
          const reason = abortSignal?.aborted
            ? "aborted by job timeout"
            : `timed out after ${config.timeoutSeconds ?? DEFAULT_PRE_HOOK_TIMEOUT_SECONDS}s`;
          resolve({
            outcome: "error",
            exitCode,
            stdout: String(stdout),
            stderr: String(stderr),
            message: reason,
          });
          return;
        }

        if (exitCode === PRE_HOOK_SKIP_EXIT_CODE) {
          resolve({
            outcome: "skip",
            stdout: String(stdout),
            stderr: String(stderr),
          });
          return;
        }

        resolve({
          outcome: "error",
          exitCode,
          stdout: String(stdout),
          stderr: String(stderr),
          message: `exited with code ${exitCode}`,
        });
      },
    );

    // Kill child process if the cron job's abort signal fires.
    const onAbort = () => {
      child.kill();
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        child.kill();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
    const cleanup = () => {
      abortSignal?.removeEventListener("abort", onAbort);
    };
  });
}
