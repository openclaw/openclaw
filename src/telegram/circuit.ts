import type { SubsystemLogger } from "../logging.js";

export enum State {
  Closed = "closed",
  Open = "open",
  HalfOpen = "half-open",
}

export type CircuitOpts = {
  failures?: number;
  resetMs?: number;
  testAttempts?: number;
  onOpen?: () => void;
  onClose?: () => void;
};

export class Circuit {
  private state: State = State.Closed;
  private failCount = 0;
  private okCount = 0;
  private lastFailAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private failures: number;
  private resetMs: number;
  private testAttempts: number;
  private onOpen?: () => void;
  private onClose?: () => void;
  private logger: SubsystemLogger;

  constructor(logger: SubsystemLogger, opts: CircuitOpts = {}) {
    this.logger = logger;
    this.failures = opts.failures || 5;
    this.resetMs = opts.resetMs || 30000;
    this.testAttempts = opts.testAttempts || 2;
    this.onOpen = opts.onOpen;
    this.onClose = opts.onClose;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === State.Open) {
      if (!this.shouldRetry()) {
        throw new Error("circuit open");
      }
      this.setState(State.HalfOpen);
    }

    try {
      const result = await fn();
      this.success();
      return result;
    } catch (err) {
      this.fail();
      throw err;
    }
  }

  private success() {
    this.failCount = 0;
    this.lastFailAt = null;

    if (this.state === State.HalfOpen) {
      this.okCount++;
      if (this.okCount >= this.testAttempts) {
        this.setState(State.Closed);
        this.okCount = 0;
      }
    }
  }

  private fail() {
    this.failCount++;
    this.lastFailAt = Date.now();

    if (this.state === State.HalfOpen) {
      this.setState(State.Open);
      this.okCount = 0;
      this.scheduleRetry();
    } else if (this.state === State.Closed && this.failCount >= this.failures) {
      this.setState(State.Open);
      this.scheduleRetry();
    }
  }

  private shouldRetry(): boolean {
    if (!this.lastFailAt) {
      return true;
    }
    return Date.now() - this.lastFailAt >= this.resetMs;
  }

  private scheduleRetry() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      if (this.state === State.Open) {
        this.setState(State.HalfOpen);
      }
    }, this.resetMs);
  }

  private setState(next: State) {
    if (this.state === next) {
      return;
    }
    this.logger.debug(`circuit: ${this.state} → ${next}`);
    this.state = next;
    if (next === State.Open) {
      this.onOpen?.();
    }
    if (next === State.Closed) {
      this.onClose?.();
    }
  }

  getState() {
    return this.state;
  }

  reset() {
    this.failCount = 0;
    this.okCount = 0;
    this.lastFailAt = null;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.setState(State.Closed);
  }
}
