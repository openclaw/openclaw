import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { ChatRunStartupState } from "./chat-run-startup.ts";

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
type ChatRunPublication = "immediate" | "animation-frame";

const presentations = new WeakMap<object, ChatRunPresentation<object>>();

function sameStartupPresentation(
  left: ChatRunStartupState | null | undefined,
  right: ChatRunStartupState | null | undefined,
): boolean {
  if (left?.state !== right?.state || left?.runId !== right?.runId) {
    return false;
  }
  if (left?.state !== "status" || right?.state !== "status") {
    return true;
  }
  if (left.phase !== right.phase) {
    return false;
  }
  if (left.phase === "waiting_for_model" && right.phase === "waiting_for_model") {
    return left.waitReason === right.waitReason;
  }
  if (
    (left.phase === "retrying" || left.phase === "fallback") &&
    (right.phase === "retrying" || right.phase === "fallback")
  ) {
    return left.retryAt === right.retryAt;
  }
  return true;
}

/** Synchronous run state and frame-coalesced rendering notifications. */
class ChatRunPresentation<T extends object> {
  readonly values: ChatRunFields<T> & {
    chatRunStartup?: ChatRunStartupState | null;
    chatRunId?: string | null;
  } = {};
  readonly fields = RUN_FIELDS;
  frame: number | null = null;
  private readonly listeners = createChangeListeners();
  private readonly nonTextListeners = createChangeListeners();
  private readonly pendingPresentations = new Set<() => void>();
  private nonTextChanged = false;
  private publishedStartup: ChatRunStartupState | null | undefined;
  private depth = 0;
  private changed = false;
  private pendingRunPublication = false;
  private cadence: ChatRunPublication | false = false;

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
          const previous = Reflect.get(this.values, key);
          if (Object.is(previous, value)) {
            return;
          }
          Object.defineProperty(this.values, key, { value });
          // Arrival and removal change row membership; continuing text does not.
          this.nonTextChanged ||=
            key !== "chatRunStartup" &&
            (key !== "chatStream" ||
              (typeof previous === "string") !== (typeof value === "string"));
          if (this.depth > 0) {
            this.changed = true;
          } else {
            this.publish("immediate", false);
          }
        },
      });
    }
    this.publishedStartup = this.values.chatRunStartup;
    Object.defineProperty(host, "chatStreamRenderFrame", {
      configurable: true,
      enumerable: true,
      get: () => this.frame,
      set: (frame: number | null) => {
        this.frame = frame;
      },
    });
  }

  readonly subscribe = this.listeners.subscribe;
  readonly subscribeNonText = this.nonTextListeners.subscribe;

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
      if (this.depth === 0 && (this.changed || this.pendingPresentations.size > 0)) {
        const changed = this.changed;
        this.changed = false;
        if (this.cadence) {
          this.pendingRunPublication ||= changed;
          this.schedule(this.cadence);
        }
      }
    }
  }

  publish(mode: ChatRunPublication = "immediate", forceNonText = true): void {
    // Ordinary explicit publications also cover mutations inside retained objects.
    this.nonTextChanged ||= forceNonText;
    if (this.depth > 0) {
      this.changed = true;
      if (mode === "immediate") {
        this.cadence = mode;
      }
      return;
    }
    this.pendingRunPublication = true;
    this.schedule(mode);
  }

  queuePresentation(notify: () => void): void {
    this.pendingPresentations.add(notify);
    if (this.depth === 0) {
      this.schedule(this.values.chatRunId || this.frame !== null ? "animation-frame" : "immediate");
    }
  }

  cancelPresentation(notify: () => void): void {
    this.pendingPresentations.delete(notify);
  }

  flushPendingPresentation(): void {
    this.cancelScheduledFrame();
    this.notify();
  }

  private schedule(mode: ChatRunPublication): void {
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
    this.flushPendingPresentation();
  }

  cancelFrame(): void {
    this.cancelScheduledFrame();
    this.pendingPresentations.clear();
    this.pendingRunPublication = false;
  }

  private cancelScheduledFrame(): void {
    if (this.frame !== null) {
      globalThis.cancelAnimationFrame?.(this.frame);
      this.frame = null;
    }
  }

  private readonly notify = () => {
    const changed = this.pendingRunPublication;
    this.pendingRunPublication = false;
    const pending = Array.from(this.pendingPresentations);
    if (changed) {
      // Preserve every sequence update, but compare the final displayed status of the frame.
      const startup = this.values.chatRunStartup;
      const nonTextChanged =
        this.nonTextChanged || !sameStartupPresentation(this.publishedStartup, startup);
      this.publishedStartup = startup;
      this.nonTextChanged = false;
      this.listeners.publish();
      if (nonTextChanged) {
        this.nonTextListeners.publish();
      }
    }
    for (const notify of pending) {
      if (this.pendingPresentations.delete(notify)) {
        notify();
      }
    }
  };
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
