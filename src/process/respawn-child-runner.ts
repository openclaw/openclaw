import type { ChildProcess, spawn } from "node:child_process";
import type { attachChildProcessBridge } from "./child-process-bridge.js";
import { signalProcessTree } from "./kill-tree.js";

const RESPAWN_SIGNAL_EXIT_GRACE_MS = 1_000;
const RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS = 1_000;
const RESPAWN_SIGNAL_HARD_EXIT_GRACE_MS = 1_000;

export type RespawnChildRuntime = {
  spawn: typeof spawn;
  attachChildProcessBridge: typeof attachChildProcessBridge;
  exit: (code?: number) => never;
};

export function runRespawnChildWithSignalBridge(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  detachForProcessTree?: boolean;
  stdioIsTerminal?: boolean;
  runtime: RespawnChildRuntime;
  onError: (error: unknown) => void | Promise<void>;
}): ChildProcess {
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
  let signalHardExitTimer: NodeJS.Timeout | undefined;
  let firstForwardedSignal: NodeJS.Signals | undefined;
  let hardKillBackstopStarted = false;
  const clearSignalTimers = (): void => {
    clearTimeout(signalExitTimer);
    clearTimeout(signalForceKillTimer);
    clearTimeout(signalHardExitTimer);
    signalExitTimer = undefined;
    signalForceKillTimer = undefined;
    signalHardExitTimer = undefined;
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
      signalHardExitTimer = setTimeout(() => {
        runtime.exit(1);
      }, RESPAWN_SIGNAL_HARD_EXIT_GRACE_MS);
      signalHardExitTimer.unref?.();
    }, RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = (signal: NodeJS.Signals): void => {
    firstForwardedSignal ??= signal;
    if (signalExitTimer) {
      return;
    }
    signalExitTimer = setTimeout(() => {
      requestChildTermination();
    }, RESPAWN_SIGNAL_EXIT_GRACE_MS);
    signalExitTimer.unref?.();
  };

  runtime.attachChildProcessBridge(child, {
    onSignal: scheduleParentExit,
  });

  child.once("exit", (code, signal) => {
    if (firstForwardedSignal && detachForProcessTree) {
      signalChild("SIGKILL");
    }
    clearSignalTimers();
    if (signal) {
      if (process.platform !== "win32") {
        process.kill(process.pid, signal);
        return;
      }
      const forwardedSignalExitCode =
        !hardKillBackstopStarted && signal === firstForwardedSignal
          ? signal === "SIGINT"
            ? 130
            : signal === "SIGTERM"
              ? 143
              : undefined
          : undefined;
      runtime.exit(forwardedSignalExitCode ?? 1);
      return;
    }
    runtime.exit(code ?? 1);
  });

  child.on("error", (error) => {
    if (child.pid !== undefined) {
      return;
    }
    clearSignalTimers();
    const reporting = onError(error);
    const exit = () => runtime.exit(1);
    // A failed spawn retains async diagnostics until settled, including formatter failure.
    if (reporting) {
      void reporting.then(exit, exit);
    } else {
      exit();
    }
  });

  return child;
}
