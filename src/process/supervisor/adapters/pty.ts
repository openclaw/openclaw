import type { ManagedRunStdin } from "../types.js";
import { killProcessTree } from "../../kill-tree.js";
import { toStringEnv } from "./env.js";

type PtyExitEvent = { exitCode: number; signal?: number };
type PtyDisposable = { dispose: () => void };
type PtySpawnHandle = {
  pid: number;
  write: (data: string | Buffer) => void;
  onData: (listener: (value: string) => void) => PtyDisposable | void;
  onExit: (listener: (event: PtyExitEvent) => void) => PtyDisposable | void;
  kill: (signal?: string) => void;
};
type PtySpawn = (
  file: string,
  args: string[] | string,
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtySpawnHandle;

type PtyModule = {
  spawn?: PtySpawn;
  default?: {
    spawn?: PtySpawn;
  };
};

export type PtyAdapter = {
  pid?: number;
  stdin?: ManagedRunStdin;
  onStdout: (listener: (chunk: string) => void) => void;
  onStderr: (listener: (chunk: string) => void) => void;
  wait: () => Promise<{ code: number | null; signal: NodeJS.Signals | number | null }>;
  kill: (signal?: NodeJS.Signals) => void;
  dispose: () => void;
};

export async function createPtyAdapter(params: {
  shell: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  name?: string;
}): Promise<PtyAdapter> {
  const module = (await import("@lydell/node-pty")) as unknown as PtyModule;
  const spawn = module.spawn ?? module.default?.spawn;
  if (!spawn) {
    throw new Error("PTY support is unavailable (node-pty spawn not found).");
  }
  const pty = spawn(params.shell, params.args, {
    cwd: params.cwd,
    env: params.env ? toStringEnv(params.env) : undefined,
    name: params.name ?? process.env.TERM ?? "xterm-256color",
    cols: params.cols ?? 120,
    rows: params.rows ?? 30,
  });

  let dataListener: PtyDisposable | null = null;
  let exitListener: PtyDisposable | null = null;
  let waitResult: { code: number | null; signal: NodeJS.Signals | number | null } | null = null;
  let resolveWait:
    | ((value: { code: number | null; signal: NodeJS.Signals | number | null }) => void)
    | null = null;
  let waitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | number | null }> | null =
    null;

  const settleWait = (value: { code: number | null; signal: NodeJS.Signals | number | null }) => {
    if (waitResult) {
      return;
    }
    waitResult = value;
    if (resolveWait) {
      const resolve = resolveWait;
      resolveWait = null;
      resolve(value);
    }
  };

  exitListener =
    pty.onExit((event) => {
      const signal = event.signal && event.signal !== 0 ? event.signal : null;
      settleWait({ code: event.exitCode ?? null, signal });
    }) ?? null;

  const stdin: ManagedRunStdin = {
    destroyed: false,
    write: (data, cb) => {
      try {
        pty.write(data);
        cb?.(null);
      } catch (err) {
        cb?.(err as Error);
      }
    },
    end: () => {
      try {
        const eof = process.platform === "win32" ? "\x1a" : "\x04";
        pty.write(eof);
      } catch {
        // ignore EOF errors
      }
    },
  };

  const onStdout = (listener: (chunk: string) => void) => {
    dataListener =
      pty.onData((chunk) => {
        listener(chunk.toString());
      }) ?? null;
  };

  const onStderr = (_listener: (chunk: string) => void) => {
    // PTY gives a unified output stream.
  };

  const wait = async () => {
    if (waitResult) {
      return waitResult;
    }
    if (!waitPromise) {
      waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | number | null }>(
        (resolve) => {
          resolveWait = resolve;
          if (waitResult) {
            const settled = waitResult;
            resolveWait = null;
            resolve(settled);
          }
        },
      );
    }
    return waitPromise;
  };

  const kill = (signal: NodeJS.Signals = "SIGKILL") => {
    try {
      if (signal === "SIGKILL" && typeof pty.pid === "number" && pty.pid > 0) {
        killProcessTree(pty.pid);
      } else if (process.platform === "win32") {
        pty.kill();
      } else {
        pty.kill(signal);
      }
    } catch {
      // ignore kill errors
    }
    // Some PTY hosts do not emit `onExit` reliably after kill.
    // Ensure waiters can progress on forced termination.
    settleWait({ code: null, signal });
  };

  const dispose = () => {
    try {
      dataListener?.dispose();
    } catch {
      // ignore disposal errors
    }
    try {
      exitListener?.dispose();
    } catch {
      // ignore disposal errors
    }
    dataListener = null;
    exitListener = null;
    settleWait({ code: null, signal: null });
  };

  return {
    pid: pty.pid || undefined,
    stdin,
    onStdout,
    onStderr,
    wait,
    kill,
    dispose,
  };
}
