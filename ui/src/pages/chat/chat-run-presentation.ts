import type { ChatPageHost } from "./chat-state-host.ts";

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
] as const satisfies readonly (keyof ChatPageHost)[];

type RunField = (typeof RUN_FIELDS)[number];
type ChatRunFields = Partial<Pick<ChatPageHost, RunField>>;
export type ChatRunPublication = "immediate" | "animation-frame";

const presentations = new WeakMap<object, ChatRunPresentation>();

/** Synchronous run state with one publication boundary for each accepted event. */
class ChatRunPresentation {
  readonly values: ChatRunFields = {};
  readonly fields = RUN_FIELDS;
  frame: number | null = null;
  private listeners = new Set<() => void>();
  private depth = 0;
  private changed = false;
  private cadence: ChatRunPublication | false = false;

  constructor(host: object) {
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
        get: () => this.values[key],
        set: (value: ChatRunFields[typeof key]) => {
          if (Object.is(this.values[key], value)) {
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

  batch<T>(operation: () => T, mode?: ChatRunPublication | false): T {
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
    this.cancelFrame();
    this.notify();
  }

  cancelFrame(): void {
    if (this.frame !== null) {
      globalThis.cancelAnimationFrame?.(this.frame);
      this.frame = null;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function chatRunPresentation(host: object): ChatRunPresentation {
  let presentation = presentations.get(host);
  if (!presentation) {
    presentation = new ChatRunPresentation(host);
    presentations.set(host, presentation);
  }
  return presentation;
}
