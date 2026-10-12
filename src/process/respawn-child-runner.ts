import type { spawn } from "node:child_process";
import os from "node:os";
import type { attachChildProcessBridge } from "./child-process-bridge.js";
import { signalProcessTree } from "./kill-tree.js";

const RESPAWN_SIGNAL_EXIT_GRACE_MS = 1_000;
const RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS = 1_000;

export type RespawnChildRuntime = {
  spawn: typeof spawn;
  attachChildProcessBridge: typeof attachChildProcessBridge;
};

/** Complete only after child stdio and any failed-spawn diagnostics have settled. */
export function runRespawnChildWithSignalBridge(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  detachForProcessTree?: boolean;
  stdioIsTerminal?: boolean;
  runtime: RespawnChildRuntime;
  onError: (error: unknown) => void | Promise<void>;
}): Promise<number> {
  const { command, args, env, runtime, onError } = params;
  const stdioIsTerminal = params.stdioIsTerminal ?? (process.stdin.isTTY || process.stdout.isTTY);
  const detachForProcessTree =
    params.detachForProcessTree === true && process.platform !== "win32" && !stdioIsTerminal;
  const child = runtime.spawn(command, args, {
    stdio: "inherit",
    env,
    detached: detachForProcessTree,
    windowsHide: !stdioIsTerminal,
  });

  // Let the child honor forwarded signals first; then terminate it so the
  // wrapper process cannot stay alive indefinitely after the parent is signaled.
  let signalExitTimer: NodeJS.Timeout | undefined;
  let signalForceKillTimer: NodeJS.Timeout | undefined;
  let firstForwardedSignal: NodeJS.Signals | undefined;
  let hardKillBackstopStarted = false;
  let childExited = false;
  const clearSignalTimers = (): void => {
    clearTimeout(signalExitTimer);
    clearTimeout(signalForceKillTimer);
    signalExitTimer = undefined;
    signalForceKillTimer = undefined;
  };
  const signalChild = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      if (detachForProcessTree && typeof child.pid === "number" && child.pid > 0) {
        signalProcessTree(child.pid, signal, { detached: true });
      } else {
        child.kill(signal === "SIGKILL" && process.platform === "win32" ? "SIGTERM" : signal);
      }
    } catch {
      // Best-effort shutdown fallback.
    }
  };
  const requestChildTermination = (): void => {
    signalChild("SIGTERM");
    signalForceKillTimer = setTimeout(() => {
      hardKillBackstopStarted = true;
      signalChild("SIGKILL");
    }, RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = (signal: NodeJS.Signals): void => {
    if (childExited) {
      return;
    }
    firstForwardedSignal ??= signal;
    if (signalExitTimer) {
      return;
    }
    signalExitTimer = setTimeout(() => {
      requestChildTermination();
    }, RESPAWN_SIGNAL_EXIT_GRACE_MS);
    signalExitTimer.unref?.();
  };

  const bridge = runtime.attachChildProcessBridge(child, {
    onSignal: scheduleParentExit,
  });

  child.once("exit", () => {
    childExited = true;
    if (firstForwardedSignal && detachForProcessTree) {
      signalChild("SIGKILL");
    }
    clearSignalTimers();
  });

  return new Promise<number>((resolve) => {
    let failed = false;
    let reporting = Promise.resolve();
    child.on("error", (error) => {
      if (child.pid !== undefined || failed) {
        return;
      }
      failed = true;
      clearSignalTimers();
      try {
        // Failed-spawn diagnostics belong to completion, including formatter failure.
        reporting = Promise.resolve(onError(error)).catch(() => undefined);
      } catch {
        // A synchronous formatter failure must still settle the failed spawn.
      }
    });
    child.once("close", (code, signal) => {
      childExited = true;
      clearSignalTimers();
      const signalCode = signal && os.constants.signals[signal];
      const forwardedSignalExitCode =
        !hardKillBackstopStarted && signal === firstForwardedSignal
          ? signal === "SIGINT"
            ? 130
            : signal === "SIGTERM"
              ? 143
              : undefined
          : undefined;
      const exitCode = failed
        ? 1
        : signal
          ? process.platform === "win32"
            ? (forwardedSignalExitCode ?? 1)
            : signalCode
              ? 128 + signalCode
              : 1
          : (code ?? 1);
      resolve(
        reporting.then(() => {
          bridge.detach();
          // Supervisors distinguish Unix signal termination from explicit numeric failures.
          if (!failed && signal && process.platform !== "win32") {
            process.kill(process.pid, signal);
          }
          return exitCode;
        }),
      );
    });
  });
}
