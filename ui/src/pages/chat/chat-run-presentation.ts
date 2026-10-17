const RUN_FIELDS = [
  "chatMessages",
  "chatPendingInputs",
  "chatRunId",
  "chatRunUsageById",
  "chatRunSessionAbortable",
  "chatStream",
  "chatStreamStartedAt",
  "chatStreamSegments",
  "chatReasoning",
  "chatRunStartup",
  "chatRunError",
  "chatToolMessages",
  "guardianNotices",
  "providerPolicyNotice",
  "compactionStatus",
  "fallbackStatus",
  "observerDigest",
  "chatRunStatus",
  "chatSessionApprovalQueue",
  "waitingApprovalStatuses",
] as const;

type RunField = (typeof RUN_FIELDS)[number];
type ChatRunFields<T> = Partial<Pick<T, Extract<RunField, keyof T>>>;
export type ChatRunPublication = "immediate" | "animation-frame";

const presentations = new WeakMap<object, ChatRunPresentation<object>>();

/** Synchronous run state with one publication boundary for each accepted event. */
class ChatRunPresentation<T extends object> {
  readonly values: ChatRunFields<T> = {};
  readonly fields = RUN_FIELDS;
  frame: number | null = null;
  private listeners = new Set<() => void>();
  private depth = 0;
  private changed = false;
  private cadence: ChatRunPublication | false = false;
  private viewUpdate: (() => void) | undefined;

  constructor(host: T) {
    const pendingFrame: unknown = Reflect.get(host, "chatStreamRenderFrame");
    this.frame = typeof pendingFrame === "number" ? pendingFrame : null;
    for (const key of RUN_FIELDS) {
      Object.defineProperty(this.values, key, {
        value: Reflect.get(host, key),
        writable: true,
        enumerable: true,
      });
      Object.defineProperty(host, key, {
        configurable: true,
        enumerable: true,
        get: () => Reflect.get(this.values, key),
        set: (value: unknown) => {
          if (Object.is(Reflect.get(this.values, key), value)) {
            return;
          }
          Object.defineProperty(this.values, key, { value });
          if (this.depth > 0) {
            this.changed = true;
          } else {
            this.publish();
          }
        },
      });
    }
    Object.defineProperty(host, "chatStreamRenderFrame", {
      configurable: true,
      enumerable: true,
      get: () => this.frame,
      set: (frame: number | null) => (this.frame = frame),
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  batch<TResult>(operation: () => TResult, mode?: ChatRunPublication | false): TResult {
    if (this.depth === 0) {
      this.cadence = mode ?? "immediate";
    } else if (mode === "immediate") {
      this.cadence = mode;
    }
    this.depth += 1;
    try {
      return operation();
    } finally {
      this.depth -= 1;
      if (this.depth === 0 && this.changed) {
        this.changed = false;
        if (this.cadence) {
          this.publish(this.cadence);
        }
      }
    }
  }

  publish(mode: ChatRunPublication = "immediate"): void {
    if (this.depth > 0) {
      this.changed = true;
      if (mode === "immediate") {
        this.cadence = mode;
      }
      return;
    }
    if (
      mode === "animation-frame" &&
      globalThis.document?.visibilityState !== "hidden" &&
      typeof globalThis.requestAnimationFrame === "function"
    ) {
      if (this.frame === null) {
        const frame = globalThis.requestAnimationFrame(() => {
          if (this.frame !== frame) {
            return;
          }
          this.frame = null;
          this.notify();
        });
        this.frame = frame;
      }
      return;
    }
    this.clearFrame();
    this.notify();
  }

  requestViewUpdate(update: () => void, mode: ChatRunPublication): void {
    this.viewUpdate = update;
    this.publish(mode);
  }

  cancelFrame(): void {
    this.clearFrame();
    this.viewUpdate = undefined;
  }

  private clearFrame(): void {
    if (this.frame !== null) {
      globalThis.cancelAnimationFrame?.(this.frame);
      this.frame = null;
    }
  }

  private notify(): void {
    const update = this.viewUpdate;
    this.viewUpdate = undefined;
    for (const listener of this.listeners) {
      listener();
    }
    update?.();
  }
}

export function chatRunPresentation<T extends object>(host: T): ChatRunPresentation<T> {
  let presentation = presentations.get(host);
  if (!presentation) {
    presentation = new ChatRunPresentation(host);
    presentations.set(host, presentation);
  }
  // SAFETY: Each presentation is created from, and cached only by, this exact host object.
  return presentation as ChatRunPresentation<T>;
}
