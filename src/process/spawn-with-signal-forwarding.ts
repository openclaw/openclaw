import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import process from "node:process";

export type SpawnWithSignalForwardingOptions = {
  signals?: NodeJS.Signals[];
};

export function spawnWithSignalForwarding(
  command: string,
  args: string[],
  options: SpawnOptions,
  { signals = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] }: SpawnWithSignalForwardingOptions = {},
): { child: ChildProcess; detach: () => void } {
  const child = spawn(command, args, options);

  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const listener = (): void => {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }

  const detach = (): void => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
  };

  child.once("exit", detach);

  return { child, detach };
}
