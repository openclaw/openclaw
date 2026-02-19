/**
 * Gate script evaluation for cron jobs.
 *
 * A gate is a short-lived shell command that runs before the agent turn.
 * The agent fires only when the gate exits with the configured `triggerExitCode`
 * (default 0). Any other exit code silently skips the job for that tick.
 *
 * Design goals:
 *  - Zero cost when the condition is not met (no LLM call at all).
 *  - Hard time-bounded: a hung script cannot block the cron lane indefinitely.
 *  - Portable: uses Node's built-in `child_process.execFile` routed through the
 *    OS shell (`/bin/sh -c` on POSIX, `cmd /c` on Windows).
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";
import type { Logger } from "./service/state.js";
import type { CronGate } from "./types.js";

/** Default gate timeout in milliseconds. */
const DEFAULT_GATE_TIMEOUT_MS = 30_000;

/** Default exit code that allows the agent turn to proceed. */
const DEFAULT_TRIGGER_EXIT_CODE = 0;

export type GateResult =
  | { passed: true }
  | { passed: false; exitCode: number | null; stderr: string; timedOut: boolean };

/**
 * Run the gate script and return whether the agent turn should proceed.
 *
 * - Resolves with `{ passed: true }` when the process exits with `triggerExitCode`.
 * - Resolves with `{ passed: false, ... }` for any other exit code, timeout, or error.
 * - Never rejects — all errors are surfaced as `passed: false`.
 */
export async function runGate(gate: CronGate, log: Logger): Promise<GateResult> {
  const triggerExitCode = gate.triggerExitCode ?? DEFAULT_TRIGGER_EXIT_CODE;
  const timeoutMs = gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const command = gate.command.trim();

  if (!command) {
    log.warn({}, "cron:gate: empty gate command — skipping job");
    return { passed: false, exitCode: null, stderr: "empty gate command", timedOut: false };
  }

  // Route through the OS shell so the full shell syntax is available
  // (pipes, &&, environment variable expansion, etc.).
  const isWindows = platform() === "win32";
  const [bin, ...args] = isWindows ? ["cmd", "/c", command] : ["/bin/sh", "-c", command];

  log.debug({ command, timeoutMs, triggerExitCode }, "cron:gate: running gate script");

  return new Promise<GateResult>((resolve) => {
    let settled = false;

    const settle = (result: GateResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const child = execFile(
      bin,
      args,
      { timeout: 0 /* we handle timeout ourselves */ },
      (err, _stdout, stderr) => {
        const exitCode = err && "code" in err ? (err.code as number | null) : 0;
        const normalizedCode = typeof exitCode === "number" ? exitCode : null;
        const passed = normalizedCode === triggerExitCode;

        log.debug(
          { command, exitCode: normalizedCode, triggerExitCode, passed },
          "cron:gate: gate script completed",
        );

        settle({ passed, exitCode: normalizedCode, stderr: stderr.trim(), timedOut: false });
      },
    );

    const timer = setTimeout(() => {
      log.warn({ command }, "cron:gate: gate script timed out");
      settle({ passed: false, exitCode: null, stderr: "", timedOut: true });
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore — process may have already exited */
      }
    }, timeoutMs);

    // Clean up the timer once the child exits so it doesn't hold the event loop.
    child.on("exit", () => clearTimeout(timer));
  });
}
