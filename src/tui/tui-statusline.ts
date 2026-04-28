/**
 * TUI StatusLine — periodically executes an external command
 * and renders its stdout as ANSI text in a fixed TUI area.
 *
 * Follows existing patterns:
 * - Timer management from tui.ts statusTimer
 * - Command spawning from tui-local-shell.ts
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export type SpawnFn = typeof nodeSpawn;

export type StatusLineOptions = {
  /** Shell command to execute */
  command: string;
  /** Refresh interval in ms (default: 1000, minimum: 500) */
  refreshInterval?: number;
  /** Execution timeout in ms (default: 500) */
  timeout?: number;
  /** Called with stdout content after each successful execution */
  onOutput: (output: string) => void;
  /** Environment variables to inject */
  env?: Record<string, string>;
  /** Spawn function override; defaults to node:child_process spawn (used in tests). */
  spawnCommand?: SpawnFn;
};

export type StatusLineHandle = {
  start: () => void;
  stop: () => void;
};

const MAX_OUTPUT_BYTES = 4096;
const MIN_REFRESH_MS = 500;
const DEFAULT_REFRESH_MS = 1000;
const DEFAULT_TIMEOUT_MS = 500;
/** Grace period after SIGTERM before escalating to SIGKILL. */
const KILL_GRACE_MS = 200;

/**
 * Send SIGTERM, then escalate to SIGKILL after a short grace period
 * if the child is still running. Children that trap SIGTERM cannot
 * silently leak past stop() or the timeout path.
 */
function killChild(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already exited */
  }
  const sigkillTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }
  }, KILL_GRACE_MS);
  sigkillTimer.unref?.();
}

export function createStatusLine(opts: StatusLineOptions): StatusLineHandle {
  const refreshInterval = Math.max(opts.refreshInterval ?? DEFAULT_REFRESH_MS, MIN_REFRESH_MS);
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const spawn: SpawnFn = opts.spawnCommand ?? nodeSpawn;

  let timer: NodeJS.Timeout | null = null;
  let executing = false;
  let lastOutput = "";
  let currentChild: ChildProcess | null = null;

  function execute(): void {
    if (executing) {
      return;
    }
    executing = true;

    let stdout = "";
    let killed = false;

    const child: ChildProcess = spawn(opts.command, {
      shell: true,
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...opts.env,
        STATUSLINE: "1",
        STATUSLINE_HOST: "openclaw",
        STATUSLINE_REFRESH_MS: String(refreshInterval),
      },
      stdio: ["ignore", "pipe", "ignore"],
    });

    currentChild = child;

    const killTimer = setTimeout(() => {
      if (!killed) {
        killed = true;
        killChild(child);
      }
    }, timeout);

    child.stdout?.on("data", (buf: Buffer) => {
      stdout += buf.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
      }
    });

    child.on("close", (code: number | null) => {
      clearTimeout(killTimer);
      executing = false;
      currentChild = null;

      if (killed) {
        return;
      } // timed out — keep last output

      if (code === 0) {
        lastOutput = stdout;
        opts.onOutput(stdout); // empty string clears the display
      } else if (lastOutput.length > 0) {
        // Non-zero exit: keep displaying last good output
        opts.onOutput(lastOutput);
      }
    });

    child.on("error", () => {
      clearTimeout(killTimer);
      executing = false;
      currentChild = null;
    });
  }

  return {
    start() {
      if (timer) {
        return;
      }
      execute();
      timer = setInterval(execute, refreshInterval);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (currentChild) {
        killChild(currentChild);
        currentChild = null;
      }
    },
  };
}
