import type { TerminalBackend } from "./backend.js";
import { TerminalOutputCoalescer } from "./output-coalescer.js";

export const TERMINAL_OUTPUT_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const TERMINAL_OUTPUT_LOW_WATER_BYTES = 512 * 1024;
export const TERMINAL_OUTPUT_REASSERT_MS = 5_000;
const INTERACTIVE_OUTPUT_BYTES = 1024;
const INTERACTIVE_OUTPUT_WINDOW_MS = 100;

type TerminalOutputControllerOptions = {
  backend: Pick<TerminalBackend, "pause" | "resume">;
  getConnId: () => string | null;
  getBufferedAmount: (connId: string) => number | undefined;
  record: (chunk: string) => void;
  emit: (connId: string, data: string) => void;
  now?: () => number;
};

/** Couples PTY output batching to the owning WebSocket's send pressure. */
export class TerminalOutputController {
  private readonly backend: Pick<TerminalBackend, "pause" | "resume">;
  private readonly getConnId: () => string | null;
  private readonly getBufferedAmount: (connId: string) => number | undefined;
  private readonly record: (chunk: string) => void;
  private readonly emit: (connId: string, data: string) => void;
  private readonly now: () => number;
  private readonly coalescer: TerminalOutputCoalescer;
  private lastInputAtMs = Number.NEGATIVE_INFINITY;
  private desiredPaused = false;
  private reassertTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TerminalOutputControllerOptions) {
    this.backend = options.backend;
    this.getConnId = options.getConnId;
    this.getBufferedAmount = options.getBufferedAmount;
    this.record = options.record;
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    this.coalescer = new TerminalOutputCoalescer((data) => this.emitBuffered(data));
  }

  push(chunk: string): void {
    this.record(chunk);
    const connId = this.getConnId();
    if (connId === null) {
      return;
    }
    if (this.coalescer.isEmpty) {
      this.reconcile(connId);
    }
    const interactive =
      Buffer.byteLength(chunk, "utf8") <= INTERACTIVE_OUTPUT_BYTES &&
      this.now() - this.lastInputAtMs <= INTERACTIVE_OUTPUT_WINDOW_MS;
    this.coalescer.push(chunk, { flushNow: interactive });
  }

  noteInput(): void {
    this.lastInputAtMs = this.now();
  }

  resetOwnership(): void {
    this.coalescer.clear();
    this.lastInputAtMs = Number.NEGATIVE_INFINITY;
    if (this.reassertTimer) {
      this.desiredPaused = false;
      this.tryResume();
    }
  }

  dispose(opts?: { flush?: boolean }): void {
    this.coalescer.dispose(opts);
    if (this.reassertTimer) {
      clearInterval(this.reassertTimer);
      this.reassertTimer = null;
      this.desiredPaused = false;
      this.tryResume();
    }
  }

  private emitBuffered(data: string): void {
    const connId = this.getConnId();
    if (connId === null) {
      return;
    }
    this.emit(connId, data);
    this.reconcile(connId);
  }

  private reconcile(connId: string): void {
    const bufferedAmount = this.getBufferedAmount(connId);
    if (bufferedAmount === undefined) {
      return;
    }
    if (bufferedAmount >= TERMINAL_OUTPUT_HIGH_WATER_BYTES) {
      this.ensureReassertTimer();
      if (!this.desiredPaused) {
        this.desiredPaused = true;
        this.tryPause();
      }
      return;
    }
    if (bufferedAmount <= TERMINAL_OUTPUT_LOW_WATER_BYTES && this.desiredPaused) {
      this.desiredPaused = false;
      this.tryResume();
    }
  }

  private ensureReassertTimer(): void {
    if (this.reassertTimer) {
      return;
    }
    this.reassertTimer = setInterval(() => {
      const connId = this.getConnId();
      const bufferedAmount = connId === null ? undefined : this.getBufferedAmount(connId);
      if (bufferedAmount !== undefined) {
        if (bufferedAmount >= TERMINAL_OUTPUT_HIGH_WATER_BYTES) {
          this.desiredPaused = true;
        } else if (bufferedAmount <= TERMINAL_OUTPUT_LOW_WATER_BYTES) {
          this.desiredPaused = false;
        }
      } else {
        this.desiredPaused = false;
      }
      // Reassert both states. A missed native resume must not wedge the shell.
      if (this.desiredPaused) {
        this.tryPause();
      } else {
        this.tryResume();
      }
    }, TERMINAL_OUTPUT_REASSERT_MS);
    this.reassertTimer.unref?.();
  }

  private tryPause(): void {
    try {
      this.backend.pause();
    } catch {
      // The failsafe timer retries while pressure remains high.
    }
  }

  private tryResume(): void {
    try {
      this.backend.resume();
    } catch {
      // The failsafe timer retries after a prior pause.
    }
  }
}
