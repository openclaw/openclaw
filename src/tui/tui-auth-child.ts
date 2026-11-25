import type { ChildProcess } from "node:child_process";
import { signalProcessTree } from "../process/kill-tree.js";

const AUTH_CHILD_FORCE_EXIT_MS = 1_000;

type TuiAuthChildResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type ActiveAuthChild = {
  child: ChildProcess;
  forceTimer?: ReturnType<typeof setTimeout>;
};

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function signalAuthChild(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  if (child.pid) {
    // Auth shares the TUI foreground process group. POSIX must target only this PID;
    // Windows uses taskkill /T here so a cmd.exe launcher cannot strand its CLI child.
    signalProcessTree(child.pid, signal, { detached: false });
    return;
  }
  child.kill(signal);
}

export function createTuiAuthChildOwner() {
  let active: ActiveAuthChild | null = null;
  let closed = false;
  let childCompletion: Promise<void> = Promise.resolve();

  const cancel = (owned: ActiveAuthChild): void => {
    if (!isChildRunning(owned.child)) {
      return;
    }
    signalAuthChild(owned.child, "SIGTERM");
    owned.forceTimer = setTimeout(() => {
      if (active !== owned || !isChildRunning(owned.child)) {
        return;
      }
      signalAuthChild(owned.child, "SIGKILL");
    }, AUTH_CHILD_FORCE_EXIT_MS);
    owned.forceTimer.unref?.();
  };

  return {
    spawnAndWait: async (spawnChild: () => ChildProcess): Promise<TuiAuthChildResult> => {
      if (closed) {
        throw new Error("TUI auth child owner is closed");
      }
      if (active) {
        throw new Error("TUI auth child is already running");
      }
      const owned: ActiveAuthChild = { child: spawnChild() };
      active = owned;
      const result = new Promise<TuiAuthChildResult>((resolve, reject) => {
        const settle = (complete: () => void): void => {
          clearTimeout(owned.forceTimer);
          owned.forceTimer = undefined;
          if (active === owned) {
            active = null;
          }
          complete();
        };
        owned.child.once("error", (error) => settle(() => reject(error)));
        owned.child.once("exit", (exitCode, signal) => settle(() => resolve({ exitCode, signal })));
      });
      childCompletion = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    },
    close: (): Promise<void> => {
      if (closed) {
        return childCompletion;
      }
      closed = true;
      if (active) {
        cancel(active);
      }
      return childCompletion;
    },
  };
}
