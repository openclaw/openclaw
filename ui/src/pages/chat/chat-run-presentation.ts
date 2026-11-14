import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { ChatRunStartupState } from "./chat-run-startup.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";

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

export type ChatToolMessageSource = {
  readToolMessage(runId: string, toolCallId: string): Record<string, unknown> | undefined;
  subscribeToolMessage(runId: string, toolCallId: string, notify: () => void): () => void;
};

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

/** Synchronous run state with one publication boundary for each accepted event. */
class ChatRunPresentation<T extends object> {
  readonly values: ChatRunFields<T> & {
    chatRunStartup?: ChatRunStartupState | null;
    chatToolMessages?: Record<string, unknown>[];
  } = {};
  readonly fields = RUN_FIELDS;
  frame: number | null = null;
  private readonly listeners = createChangeListeners();
  private readonly nonTextListeners = createChangeListeners();
  private readonly toolListeners = new Map<string, Set<() => void>>();
  private readonly changedTools = new Set<string>();
  private nonTextChanged = false;
  private publishedStartup: ChatRunStartupState | null | undefined;
  private depth = 0;
  private changed = false;
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
          const previousStartup = this.values.chatRunStartup;
          Reflect.set(this.values, key, value);
          // Sequence receipts stay synchronous; an unchanged status needs no display frame.
          if (
            key === "chatRunStartup" &&
            sameStartupPresentation(previousStartup, this.values.chatRunStartup)
          ) {
            return;
          }
          if (key === "chatToolMessages") {
            // Direct replacement is structural (reset or history pruning).
            for (const identity of this.toolListeners.keys()) {
              this.changedTools.add(identity);
            }
          }
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

  readToolMessage(runId: string, toolCallId: string) {
    return this.values.chatToolMessages?.find(
      (message) => message.runId === runId && message.toolCallId === toolCallId,
    );
  }

  subscribeToolMessage(runId: string, toolCallId: string, notify: () => void) {
    const identity = buildToolStreamIdentity(runId, toolCallId);
    let listeners = this.toolListeners.get(identity);
    if (!listeners) {
      listeners = new Set();
      this.toolListeners.set(identity, listeners);
    }
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
      if (listeners.size === 0) {
        this.toolListeners.delete(identity);
      }
    };
  }

  /** The stream owner distinguishes conversation changes from existing invocation contents. */
  publishToolMessages(
    messages: Record<string, unknown>[],
    structureChanged: boolean,
    changedTools: Iterable<string>,
  ) {
    for (const identity of changedTools) {
      this.changedTools.add(identity);
    }
    Reflect.set(this.values, "chatToolMessages", messages);
    this.nonTextChanged ||= structureChanged;
    this.publish("immediate", false);
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
          this.publish(this.cadence, false);
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

  private readonly notify = () => {
    // Preserve every sequence update, but compare the final displayed status of the frame.
    const startup = this.values.chatRunStartup;
    const nonTextChanged =
      this.nonTextChanged || !sameStartupPresentation(this.publishedStartup, startup);
    this.publishedStartup = startup;
    this.nonTextChanged = false;
    const changedTools = [...this.changedTools];
    this.changedTools.clear();
    this.listeners.publish();
    if (nonTextChanged) {
      this.nonTextListeners.publish();
    }
    for (const identity of changedTools) {
      for (const notify of this.toolListeners.get(identity) ?? []) {
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
