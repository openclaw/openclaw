import type { ChildProcess } from "node:child_process";
import process from "node:process";

type ChildProcessBridgeOptions = {
  signals?: NodeJS.Signals[];
  onSignal?: (signal: NodeJS.Signals) => void;
};

const defaultSignals: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

/** Forwards process termination signals to a child and detaches on terminal lifecycle events. */
export function attachChildProcessBridge(
  child: ChildProcess,
  { signals = defaultSignals, onSignal }: ChildProcessBridgeOptions = {},
): { detach: () => void } {
  const listeners = new Map<NodeJS.Signals, () => void>();
  let childExited = false;
  for (const signal of signals) {
    const listener = (): void => {
      if (childExited) {
        return;
      }
      onSignal?.(signal);
      try {
        child.kill(signal);
      } catch {}
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

  // Child errors can report failed signal/IPC operations while the PID stays live.
  // Stop forwarding at exit, but retain the handlers while final pipes drain so
  // a second signal cannot terminate the parent before its close boundary.
  child.once("exit", () => {
    childExited = true;
  });
  child.once("close", detach);

  return { detach };
}
