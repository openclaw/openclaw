import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { killProcessTree } from "../../kill-tree.js";
import { spawnWithFallback } from "../../spawn-utils.js";
import type { ManagedRunStdin, SpawnProcessAdapter } from "../types.js";
import { toStringEnv } from "./env.js";

function resolveCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  const lower = command.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return command;
  }
  const basename = lower.split(/[\\/]/).pop() ?? lower;
  if (basename === "npm" || basename === "pnpm" || basename === "yarn" || basename === "npx") {
    return `${command}.cmd`;
  }
  return command;
}

export type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;

export async function createChildAdapter(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
}): Promise<ChildAdapter> {
  const resolvedArgv = [...params.argv];
  resolvedArgv[0] = resolveCommand(resolvedArgv[0] ?? "");

  const stdinMode = params.stdinMode ?? (params.input !== undefined ? "pipe-closed" : "inherit");

  // On Windows, `detached: true` creates a new process group and can prevent
  // stdout/stderr pipes from connecting when running under a Scheduled Task
  // (headless, no console). Default to `detached: false` on Windows; on
  // POSIX systems keep `detached: true` so the child survives parent exit.
  const useDetached = process.platform !== "win32";

  const options: SpawnOptions = {
    cwd: params.cwd,
    env: params.env ? toStringEnv(params.env) : undefined,
    stdio: ["pipe", "pipe", "pipe"],
    detached: useDetached,
    windowsHide: true,
    windowsVerbatimArguments: params.windowsVerbatimArguments,
  };
  if (stdinMode === "inherit") {
    options.stdio = ["inherit", "pipe", "pipe"];
  } else {
    options.stdio = ["pipe", "pipe", "pipe"];
  }

  const spawned = await spawnWithFallback({
    argv: resolvedArgv,
    options,
    fallbacks: useDetached
      ? [
          {
            label: "no-detach",
            options: { detached: false },
          },
        ]
      : [],
  });

  const child = spawned.child as ChildProcessWithoutNullStreams;
  if (child.stdin) {
    if (params.input !== undefined) {
      child.stdin.write(params.input);
      child.stdin.end();
    } else if (stdinMode === "pipe-closed") {
      child.stdin.end();
    }
  }

  const stdin: ManagedRunStdin | undefined = child.stdin
    ? {
        destroyed: false,
        write: (data: string, cb?: (err?: Error | null) => void) => {
          try {
            child.stdin.write(data, cb);
          } catch (err) {
            cb?.(err as Error);
          }
        },
        end: () => {
          try {
            child.stdin.end();
          } catch {
            // ignore close errors
          }
        },
        destroy: () => {
          try {
            child.stdin.destroy();
          } catch {
            // ignore destroy errors
          }
        },
      }
    : undefined;

  const onStdout = (listener: (chunk: string) => void) => {
    child.stdout.on("data", (chunk) => {
      listener(chunk.toString());
    });
  };

  const onStderr = (listener: (chunk: string) => void) => {
    child.stderr.on("data", (chunk) => {
      listener(chunk.toString());
    });
  };

  const wait = async () =>
    await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false;

      const onError = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("close", onClose);
        reject(err);
      };

      const settle = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("close", onClose);
        resolve({ code, signal });
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        settle(code, signal);
      };

      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        settle(code, signal);
      };

      // Prefer process liveness (exit) over stdio closure (close): descendants can
      // keep inherited pipes open after the tracked child PID exits.
      child.on("error", onError);
      child.on("exit", onExit);
      child.on("close", onClose);
    });

  const kill = (signal?: NodeJS.Signals) => {
    const pid = child.pid ?? undefined;
    if (signal === undefined || signal === "SIGKILL") {
      if (pid) {
        killProcessTree(pid);
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore kill errors
        }
      }
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // ignore kill errors for non-kill signals
    }
  };

  const dispose = () => {
    child.removeAllListeners();
  };

  return {
    pid: child.pid ?? undefined,
    stdin,
    onStdout,
    onStderr,
    wait,
    kill,
    dispose,
  };
}
