// Child process bridge adapts child process events into typed lifecycle callbacks.
import type { ChildProcess } from "node:child_process";
import process from "node:process";

/** Signal forwarding options for a child process bridge. */
export type ChildProcessBridgeOptions = {
  signals?: NodeJS.Signals[];
  onSignal?: (signal: NodeJS.Signals) => void;
};

/** Internal env key marking the wrapper PID that spawned a respawn child. */
export const OPENCLAW_RESPAWN_PARENT_PID = "OPENCLAW_RESPAWN_PARENT_PID";
const DEFAULT_PARENT_DEATH_GUARD_INTERVAL_MS = 250;

type ParentDeathGuardRuntime = {
  env: NodeJS.ProcessEnv;
  exit: (code?: number) => never;
  pid: number;
  platform: NodeJS.Platform;
  ppid: () => number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

const defaultSignals: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

/** Adds the wrapper PID marker to a respawn child's env on Unix. */
export function withChildProcessParentGuardEnv(params: {
  env: NodeJS.ProcessEnv;
  parentPid?: number;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  if ((params.platform ?? process.platform) === "win32") {
    return params.env;
  }
  return {
    ...params.env,
    [OPENCLAW_RESPAWN_PARENT_PID]: String(params.parentPid ?? process.pid),
  };
}

/**
 * Starts a parent-death guard in a respawned child.
 *
 * If the env marker names the current wrapper PID, the child polls its ppid and
 * exits when it is reparented (e.g. wrapper SIGKILL/crash). The marker is
 * consumed so nested child commands cannot inherit a stale wrapper PID.
 */
export function installChildProcessParentDeathGuard(
  params: {
    intervalMs?: number;
    runtime?: Partial<ParentDeathGuardRuntime>;
  } = {},
): { detach: () => void } | null {
  const runtime: ParentDeathGuardRuntime = {
    env: process.env,
    exit: process.exit.bind(process) as (code?: number) => never,
    pid: process.pid,
    platform: process.platform,
    ppid: () => process.ppid,
    setInterval,
    clearInterval,
    ...params.runtime,
  };
  if (runtime.platform === "win32") {
    return null;
  }
  const parentPid = Number(runtime.env[OPENCLAW_RESPAWN_PARENT_PID]);
  delete runtime.env[OPENCLAW_RESPAWN_PARENT_PID];
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid === runtime.pid) {
    return null;
  }

  let detached = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const detach = (): void => {
    detached = true;
    if (timer) {
      runtime.clearInterval(timer);
      timer = undefined;
    }
  };
  const terminateIfOrphaned = (): void => {
    if (detached || runtime.ppid() === parentPid) {
      return;
    }
    detach();
    runtime.exit(1);
  };

  timer = runtime.setInterval(
    terminateIfOrphaned,
    params.intervalMs ?? DEFAULT_PARENT_DEATH_GUARD_INTERVAL_MS,
  );
  timer.unref?.();
  terminateIfOrphaned();

  return { detach };
}

/** Forwards process termination signals to a child and detaches on child exit/error. */
export function attachChildProcessBridge(
  child: ChildProcess,
  { signals = defaultSignals, onSignal }: ChildProcessBridgeOptions = {},
): { detach: () => void } {
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const listener = (): void => {
      onSignal?.(signal);
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    };
    try {
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch {
      // Unsupported signal on this platform.
    }
  }

  const detach = (): void => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
  };

  child.once("exit", detach);
  child.once("error", detach);

  return { detach };
}
