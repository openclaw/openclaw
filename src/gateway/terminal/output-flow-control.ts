import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import type { TerminalBackend } from "./backend.js";

const TERMINAL_OUTPUT_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const TERMINAL_OUTPUT_LOW_WATER_BYTES = 512 * 1024;
const TERMINAL_OUTPUT_REASSERT_MS = 5_000;
const INTERACTIVE_OUTPUT_BYTES = 1024;
const INTERACTIVE_OUTPUT_WINDOW_MS = 100;
const TERMINAL_OUTPUT_COALESCE_WINDOW_MS = 4;
const TERMINAL_OUTPUT_FRAME_BYTES = 64 * 1024;

type TerminalOutputControllerOptions = {
  backend: Pick<TerminalBackend, "pause" | "resume">;
  getConnIds: () => readonly string[];
  getBufferedAmount: (connId: string) => number | undefined;
  record: (chunk: string) => void;
  emit: (connIds: readonly string[], data: string, seq: number) => void;
};

/** Couples PTY output batching to the live recipient WebSockets' send pressure. */
export class TerminalOutputController {
  private chunks: string[] = [];
  private bufferedBytes = 0;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private endOffsetValue = 0;
  private emittedOffset = 0;
  private lastInputAtMs = Number.NEGATIVE_INFINITY;
  private desiredPaused = false;
  private reassertTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: TerminalOutputControllerOptions) {
    this.options = { ...options };
  }

  /** Cumulative UTF-16 end offset across streamed and detached output. */
  get endOffset(): number {
    return this.endOffsetValue;
  }

  push(chunk: string): void {
    this.options.record(chunk);
    this.endOffsetValue += chunk.length;
    const connIds = this.options.getConnIds();
    if (connIds.length === 0) {
      return;
    }
    if (this.chunks.length === 0) {
      this.reconcile(connIds);
    }
    const interactive =
      Buffer.byteLength(chunk, "utf8") <= INTERACTIVE_OUTPUT_BYTES &&
      Date.now() - this.lastInputAtMs <= INTERACTIVE_OUTPUT_WINDOW_MS;
    let remaining = chunk;
    while (remaining) {
      const part = truncateUtf8Prefix(remaining, TERMINAL_OUTPUT_FRAME_BYTES - this.bufferedBytes);
      if (!part) {
        this.flush();
        continue;
      }
      this.chunks.push(part);
      this.bufferedBytes += Buffer.byteLength(part, "utf8");
      remaining = remaining.slice(part.length);
      if (this.bufferedBytes >= TERMINAL_OUTPUT_FRAME_BYTES) {
        this.flush();
      }
    }
    if (interactive) {
      this.flush();
    } else if (!this.coalesceTimer && this.chunks.length > 0) {
      this.coalesceTimer = setTimeout(() => this.flush(), TERMINAL_OUTPUT_COALESCE_WINDOW_MS);
      this.coalesceTimer.unref?.();
    }
  }

  noteInput(): void {
    this.lastInputAtMs = Date.now();
  }

  /** Reassesses flow control immediately when the live recipient set changes. */
  reconcileRecipients(): void {
    this.reconcile(this.options.getConnIds());
  }

  /** Flushes existing viewers, then aligns live frames after the attach snapshot. */
  prepareViewerAttach(): void {
    this.flush();
    this.emittedOffset = this.endOffsetValue;
  }

  resetOwnership(): void {
    this.clear();
    // Cleared bytes remain in the attach snapshot; the next live frame starts
    // after that authoritative replay high-water mark.
    this.emittedOffset = this.endOffsetValue;
    this.lastInputAtMs = Number.NEGATIVE_INFINITY;
    if (this.reassertTimer) {
      this.desiredPaused = false;
      this.applyFlowControl();
    }
  }

  dispose(opts?: { flush?: boolean }): void {
    if (opts?.flush) {
      this.flush();
    } else {
      this.clear();
    }
    if (this.reassertTimer) {
      clearInterval(this.reassertTimer);
      this.reassertTimer = null;
      this.desiredPaused = false;
      this.applyFlowControl();
    }
  }

  private clear(): void {
    clearTimeout(this.coalesceTimer ?? undefined);
    this.coalesceTimer = null;
    this.chunks = [];
    this.bufferedBytes = 0;
  }

  private flush(): void {
    const chunks = this.chunks;
    this.clear();
    if (chunks.length === 0) {
      return;
    }
    const connIds = this.options.getConnIds();
    if (connIds.length === 0) {
      return;
    }
    const data = chunks.join("");
    this.emittedOffset += data.length;
    this.options.emit(connIds, data, this.emittedOffset);
    this.reconcile(connIds);
  }

  private reconcile(connIds: readonly string[]): void {
    const bufferedAmount = this.maxBufferedAmount(connIds);
    if (bufferedAmount === undefined) {
      return;
    }
    if (bufferedAmount >= TERMINAL_OUTPUT_HIGH_WATER_BYTES) {
      this.ensureReassertTimer();
      if (!this.desiredPaused) {
        this.desiredPaused = true;
        this.applyFlowControl();
      }
      return;
    }
    if (bufferedAmount <= TERMINAL_OUTPUT_LOW_WATER_BYTES && this.desiredPaused) {
      this.desiredPaused = false;
      this.applyFlowControl();
    }
  }

  private ensureReassertTimer(): void {
    if (this.reassertTimer) {
      return;
    }
    this.reassertTimer = setInterval(() => {
      const bufferedAmount = this.maxBufferedAmount(this.options.getConnIds());
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
      this.applyFlowControl();
    }, TERMINAL_OUTPUT_REASSERT_MS);
    this.reassertTimer.unref?.();
  }

  private maxBufferedAmount(connIds: readonly string[]): number | undefined {
    let maximum: number | undefined;
    for (const connId of connIds) {
      const amount = this.options.getBufferedAmount(connId);
      if (amount !== undefined && (maximum === undefined || amount > maximum)) {
        maximum = amount;
      }
    }
    return maximum;
  }

  private applyFlowControl(): void {
    try {
      this.options.backend[this.desiredPaused ? "pause" : "resume"]();
    } catch {
      // The failsafe timer reasserts the desired state after native failures.
    }
  }
}
