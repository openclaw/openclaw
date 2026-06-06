// Control UI chat module implements streaming buffer behavior.
export type ChatStreamBufferState = {
  displayText: string;
  streamComplete: boolean;
};

export class ChatStreamBuffer {
  private pending = "";
  private displayText = "";
  private streamComplete = false;
  private rafId: number | null = null;
  private scheduled = false;
  private readonly maxBatchBytes: number;

  constructor(maxBatchBytes = 4096) {
    this.maxBatchBytes = maxBatchBytes;
  }

  get state(): ChatStreamBufferState {
    return {
      displayText: this.displayText,
      streamComplete: this.streamComplete,
    };
  }

  get text(): string {
    return this.displayText;
  }

  get completed(): boolean {
    return this.streamComplete;
  }

  enqueue(delta: string): void {
    if (!delta) {
      return;
    }
    this.pending += delta;
    if (!this.scheduled) {
      this.scheduleFlush();
    }
  }

  complete(): void {
    if (this.streamComplete) {
      return;
    }
    this.streamComplete = true;
    if (!this.scheduled && this.pending) {
      this.scheduleFlush();
      return;
    }
    if (!this.pending) {
      this.flush();
    }
  }

  reset(): void {
    this.cancelScheduled();
    this.pending = "";
    this.displayText = "";
    this.streamComplete = false;
  }

  private cancelScheduled(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.scheduled = false;
  }

  private scheduleFlush(): void {
    if (typeof globalThis.requestAnimationFrame !== "function") {
      this.flush();
      return;
    }
    this.scheduled = true;
    this.rafId = globalThis.requestAnimationFrame(() => {
      this.rafId = null;
      this.scheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    const trimmed = this.pending.slice(0, this.maxBatchBytes);
    const remainder = this.pending.slice(this.maxBatchBytes);
    if (trimmed) {
      this.displayText += trimmed;
    }
    this.pending = remainder;
    if (!this.pending && !this.scheduled) {
      this.rafId = null;
    }
    if (this.pending && !this.scheduled) {
      this.scheduleFlush();
    }
  }
}
