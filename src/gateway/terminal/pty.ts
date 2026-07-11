// Thin, resize-capable PTY wrapper for the operator terminal.
//
// The process supervisor's PTY adapter is shaped for one-shot managed runs and
// hides resize; the operator terminal needs a long-lived, interactive handle, so
// it owns this narrow loader instead of reshaping the supervisor contract.
import { signalProcessTree } from "../../process/kill-tree.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";

type PtyDisposable = { dispose: () => void };

/** Live PTY handle used by one operator terminal session. */
export type TerminalPtyHandle = {
  pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  onData: (listener: (chunk: string) => void) => void;
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void;
  kill: (signal?: string) => void;
};

type PtyForkHandle = {
  readonly pid: number;
  write: (data: string) => void;
  resize: (columns: number, rows: number) => void;
  onData: (listener: (value: string) => void) => PtyDisposable | void;
  onExit: (
    listener: (value: { exitCode: number; signal?: number }) => void,
  ) => PtyDisposable | void;
  kill: (signal?: string) => void;
};

type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtyForkHandle;

type PtyModule = { spawn?: PtySpawn; default?: { spawn?: PtySpawn } };

const loadPtyModule = createLazyRuntimeModule(
  () => import("@lydell/node-pty") as Promise<unknown> as Promise<PtyModule>,
);

/** Spawns a PTY process and adapts it to the terminal session handle. */
export async function spawnTerminalPty(params: {
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}): Promise<TerminalPtyHandle> {
  const mod = await loadPtyModule();
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (!spawn) {
    throw new Error("PTY support is unavailable (node-pty spawn not found).");
  }
  const pty = spawn(params.file, params.args, {
    name: params.env.TERM ?? "xterm-256color",
    cols: params.cols,
    rows: params.rows,
    cwd: params.cwd,
    env: params.env,
  });
  return {
    get pid() {
      return pty.pid;
    },
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    onData: (listener) => {
      pty.onData(listener);
    },
    onExit: (listener) => {
      pty.onExit(listener);
    },
    kill: (signal) => killPtyTree(pty, signal),
  } satisfies TerminalPtyHandle;
}

// node-pty's kill only signals the shell; commands it launched (a long-running
// `npm install`, `sleep`, etc.) would survive close/disconnect/shutdown. Signal
// the whole process tree instead, mirroring the process supervisor's PTY adapter.
export function killPtyTree(
  pty: { pid: number; kill: (signal?: string) => void },
  signal?: string,
): void {
  const sig = (signal ?? "SIGKILL") as NodeJS.Signals;
  try {
    if ((sig === "SIGKILL" || sig === "SIGTERM") && typeof pty.pid === "number" && pty.pid > 0) {
      signalProcessTree(pty.pid, sig);
    } else if (process.platform === "win32") {
      pty.kill();
    } else {
      pty.kill(sig);
    }
  } catch {
    // Process may already be gone; teardown is best-effort.
  }
}
