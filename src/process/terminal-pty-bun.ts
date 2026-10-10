import { constants } from "node:os";
import {
  signalTerminalPtyTree,
  type TerminalPtyHandle,
  type TerminalPtySpawnParams,
} from "./terminal-pty.js";

// node-pty's DESTROY_SOCKET_TIMEOUT_MS: a descendant holding the PTY slave must
// not keep the terminal from reporting its process exit.
const OUTPUT_EOF_GRACE_MS = 200;

type BunTerminal = {
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
  pause(): void;
  resume(): void;
};

type BunTerminalSubprocess = {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly terminal?: BunTerminal;
  kill(signal?: NodeJS.Signals): void;
};

type BunTerminalRuntime = {
  spawn(
    argv: string[],
    options: {
      cwd?: string;
      env: Record<string, string>;
      terminal: {
        cols: number;
        rows: number;
        name: string;
        data(terminal: BunTerminal, data: Uint8Array): void;
        // PTY EOF or read error, not the process exit.
        exit(terminal: BunTerminal): void;
      };
    },
  ): BunTerminalSubprocess;
};

type TerminalPtyExit = { exitCode: number; signal?: number };

/** Runs a PTY on Bun's native terminal; the caller has resolved env and TERM. */
export function spawnBunTerminalPty(
  params: TerminalPtySpawnParams & { env: Record<string, string>; name: string },
): TerminalPtyHandle {
  // SAFETY: the caller checks Bun and Terminal.pause before entering this native adapter.
  const bun = (globalThis as typeof globalThis & { Bun?: BunTerminalRuntime }).Bun;
  if (!bun) {
    throw new Error("Bun's native terminal is unavailable in this runtime");
  }
  const decoder = new TextDecoder();
  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(event: TerminalPtyExit) => void>();
  // Output waits here, in order, while paused or until the first subscriber.
  let pending: string[] = [];
  let delivered = 0;
  let flushing = false;
  let paused = false;
  // After a terminating kill the PTY keeps reading despite consumer backpressure.
  let tearingDown = false;
  let outputEnded = false;
  let exitDue = false;
  let processExit: TerminalPtyExit | undefined;
  let exited: TerminalPtyExit | undefined;
  let eofGrace: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    // A listener may pause, resume, or subscribe; the outermost flush keeps draining.
    if (flushing) {
      return;
    }
    flushing = true;
    try {
      // Listeners can pause or unsubscribe mid-drain, so recheck before every chunk.
      // Teardown drains regardless of pause so output still precedes exit.
      for (;;) {
        const chunk = pending[delivered];
        if ((paused && !tearingDown) || dataListeners.size === 0 || chunk === undefined) {
          break;
        }
        delivered += 1;
        for (const listener of dataListeners) {
          listener(chunk);
        }
      }
    } finally {
      flushing = false;
    }
    // Drop consumed chunks once they are at least half the queue (amortized O(1)).
    if (delivered > 0 && delivered * 2 >= pending.length) {
      pending = pending.slice(delivered);
      delivered = 0;
    }
    // Exit follows queued output unless a live consumer still holds it paused.
    if (exitDue && processExit && !(paused && pending.length > 0 && !tearingDown)) {
      exitDue = false;
      exited = processExit;
      // Only output without any data subscriber can remain; like node-pty, drop it
      // so a late subscriber never receives data after exit.
      pending = [];
      delivered = 0;
      terminal.close();
      for (const listener of exitListeners) {
        listener(exited);
      }
    }
  };
  const deliver = (chunk: string) => {
    if (chunk) {
      pending.push(chunk);
    }
    flush();
  };
  const finish = () => {
    if (exited || exitDue || !processExit) {
      return;
    }
    clearTimeout(eofGrace);
    eofGrace = undefined;
    exitDue = true;
    deliver(decoder.decode());
  };
  const armEofGrace = () => {
    // A paused fork terminal holds its tail output until resume; wait for it.
    if (!processExit || outputEnded || exited || eofGrace || (paused && !tearingDown)) {
      return;
    }
    eofGrace = setTimeout(finish, OUTPUT_EOF_GRACE_MS);
  };

  const child = bun.spawn([params.file, ...params.args], {
    cwd: params.cwd,
    env: params.env,
    terminal: {
      cols: params.cols,
      rows: params.rows,
      name: params.name,
      data: (_terminal, data) => deliver(decoder.decode(data, { stream: true })),
      exit: () => {
        outputEnded = true;
        finish();
      },
    },
  });
  if (!child.terminal) {
    child.kill("SIGKILL");
    throw new Error("Bun did not attach a terminal to the spawned process");
  }
  const terminal = child.terminal;
  void child.exited.then(() => {
    // Match node-pty: a signalled exit reports exit code 0 plus the signal number.
    processExit = child.signalCode
      ? { exitCode: 0, signal: constants.signals[child.signalCode] }
      : { exitCode: child.exitCode ?? 0 };
    if (outputEnded) {
      finish();
    } else {
      armEofGrace();
    }
  });

  const resume = () => {
    paused = false;
    terminal.resume();
    flush();
    armEofGrace();
  };
  return {
    pid: child.pid,
    write: (data) => void terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    pause: () => {
      paused = true;
      if (!tearingDown) {
        terminal.pause();
        clearTimeout(eofGrace);
        eofGrace = undefined;
      }
    },
    resume,
    onData: (listener) => {
      dataListeners.add(listener);
      flush();
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      if (exited) {
        listener(exited);
      }
      return { dispose: () => exitListeners.delete(listener) };
    },
    kill: (signal) => {
      signalTerminalPtyTree(child.pid, signal, (direct) => child.kill(direct));
      if (exited || (signal !== undefined && signal !== "SIGKILL" && signal !== "SIGTERM")) {
        return;
      }
      // Like node-pty's socket teardown, a slow consumer must not hold the dying
      // tree's output or exit: keep reading to EOF and stop gating exit on pause.
      tearingDown = true;
      terminal.resume();
      flush();
      armEofGrace();
    },
  };
}
