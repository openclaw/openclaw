import type { StatusReactionEmojis } from "../../channels/status-reactions.js";

export type DiscordStatusLifecycleState =
  | "idle"
  | "waiting-fresh"
  | "waiting-backlog"
  | "active"
  | "done"
  | "error"
  | "cleared";

type DiscordStatusTraceStage = "queued" | "applied" | "ignored" | "failed";

export type DiscordStatusTraceEntry = {
  messageId: string;
  state: DiscordStatusLifecycleState;
  stage: DiscordStatusTraceStage;
  emoji: string | null;
  at: number;
};

export type DiscordStatusReactionAdapter = {
  setReaction: (emoji: string) => Promise<void>;
  removeReaction?: (emoji: string) => Promise<void>;
};

export type DiscordStatusReactionProjection = {
  waitingFresh: string;
  waitingBacklog: string;
  active: string;
  done: string;
  error: string;
};

export const DISCORD_STATUS_DEFAULT_PROJECTION: DiscordStatusReactionProjection = {
  waitingFresh: "👀",
  waitingBacklog: "⏳",
  active: "🤔",
  done: "✅",
  error: "❌",
};

export const DISCORD_STATUS_CLEAR_HOLD_MS = 1500;

const MAX_TRACE_ENTRIES = 2000;
const traceEntries: DiscordStatusTraceEntry[] = [];

function pushTrace(entry: DiscordStatusTraceEntry): void {
  traceEntries.push(entry);
  if (traceEntries.length > MAX_TRACE_ENTRIES) {
    traceEntries.splice(0, traceEntries.length - MAX_TRACE_ENTRIES);
  }
}

function resolveEmojiForState(
  state: DiscordStatusLifecycleState,
  projection: DiscordStatusReactionProjection,
): string | null {
  switch (state) {
    case "waiting-fresh":
      return projection.waitingFresh;
    case "waiting-backlog":
      return projection.waitingBacklog;
    case "active":
      return projection.active;
    case "done":
      return projection.done;
    case "error":
      return projection.error;
    default:
      return null;
  }
}

function isWaitingState(state: DiscordStatusLifecycleState): boolean {
  return state === "waiting-fresh" || state === "waiting-backlog";
}

function canTransition(
  from: DiscordStatusLifecycleState,
  to: DiscordStatusLifecycleState,
): boolean {
  if (from === "idle") {
    return isWaitingState(to) || to === "active";
  }
  if (isWaitingState(from)) {
    return to === "active";
  }
  if (from === "active") {
    return to === "done" || to === "error";
  }
  if (from === "done" || from === "error") {
    return to === "cleared";
  }
  return false;
}

function canEnqueueTransition(params: {
  state: DiscordStatusLifecycleState;
  lastRequestedState: DiscordStatusLifecycleState | null;
  nextState: DiscordStatusLifecycleState;
}): boolean {
  if (canTransition(params.state, params.nextState)) {
    return true;
  }
  if (
    isWaitingState(params.state) &&
    params.lastRequestedState === "active" &&
    (params.nextState === "done" || params.nextState === "error")
  ) {
    // Allow terminal transition to queue behind an in-flight active transition.
    return true;
  }
  return false;
}

function trackTransition(params: {
  messageId: string;
  state: DiscordStatusLifecycleState;
  stage: DiscordStatusTraceStage;
  emoji: string | null;
  onTrace?: (entry: DiscordStatusTraceEntry) => void;
}): void {
  const entry: DiscordStatusTraceEntry = {
    messageId: params.messageId,
    state: params.state,
    stage: params.stage,
    emoji: params.emoji,
    at: Date.now(),
  };
  pushTrace(entry);
  params.onTrace?.(entry);
}

export function resolveDiscordStatusReactionProjection(
  overrides?: StatusReactionEmojis,
  waitingFreshFallback?: string,
): DiscordStatusReactionProjection {
  const normalizedWaitingFreshFallback = waitingFreshFallback?.trim() || undefined;
  return {
    waitingFresh:
      overrides?.queued ??
      normalizedWaitingFreshFallback ??
      DISCORD_STATUS_DEFAULT_PROJECTION.waitingFresh,
    waitingBacklog: overrides?.stallSoft ?? DISCORD_STATUS_DEFAULT_PROJECTION.waitingBacklog,
    active: overrides?.thinking ?? DISCORD_STATUS_DEFAULT_PROJECTION.active,
    done: overrides?.done ?? DISCORD_STATUS_DEFAULT_PROJECTION.done,
    error: overrides?.error ?? DISCORD_STATUS_DEFAULT_PROJECTION.error,
  };
}

export function createDiscordStatusReactionLifecycle(params: {
  enabled: boolean;
  messageId: string;
  adapter: DiscordStatusReactionAdapter;
  projection: DiscordStatusReactionProjection;
  onError?: (err: unknown) => void;
  onTrace?: (entry: DiscordStatusTraceEntry) => void;
}) {
  const { enabled, messageId, adapter, projection, onError, onTrace } = params;
  let state: DiscordStatusLifecycleState = "idle";
  let lastRequestedState: DiscordStatusLifecycleState | null = null;
  let currentEmoji: string | null = null;
  let chain = Promise.resolve();
  let clearTimer: NodeJS.Timeout | null = null;
  const knownEmojis = new Set<string>([
    projection.waitingFresh,
    projection.waitingBacklog,
    projection.active,
    projection.done,
    projection.error,
  ]);

  function transition(nextState: DiscordStatusLifecycleState): Promise<void> {
    const nextEmoji = resolveEmojiForState(nextState, projection);
    trackTransition({
      messageId,
      state: nextState,
      stage: "queued",
      emoji: nextEmoji,
      onTrace,
    });

    if (!enabled) {
      state = nextState;
      return Promise.resolve();
    }
    if (nextState === state || nextState === lastRequestedState) {
      trackTransition({
        messageId,
        state: nextState,
        stage: "ignored",
        emoji: nextEmoji,
        onTrace,
      });
      return chain;
    }
    if (!canEnqueueTransition({ state, lastRequestedState, nextState })) {
      trackTransition({
        messageId,
        state: nextState,
        stage: "ignored",
        emoji: nextEmoji,
        onTrace,
      });
      return chain;
    }

    lastRequestedState = nextState;
    chain = chain.then(async () => {
      const fromState = state;
      try {
        if (!canTransition(fromState, nextState)) {
          trackTransition({
            messageId,
            state: nextState,
            stage: "ignored",
            emoji: nextEmoji,
            onTrace,
          });
          return;
        }

        if (nextState === "cleared") {
          let hadFailure = false;
          if (adapter.removeReaction) {
            for (const emoji of knownEmojis) {
              try {
                await adapter.removeReaction(emoji);
              } catch (err) {
                hadFailure = true;
                onError?.(err);
              }
            }
          }

          if (hadFailure) {
            state = fromState;
            trackTransition({
              messageId,
              state: nextState,
              stage: "failed",
              emoji: null,
              onTrace,
            });
            return;
          }

          state = nextState;
          currentEmoji = null;
          trackTransition({
            messageId,
            state: nextState,
            stage: "applied",
            emoji: null,
            onTrace,
          });
          return;
        }

        if (!nextEmoji) {
          trackTransition({
            messageId,
            state: nextState,
            stage: "ignored",
            emoji: null,
            onTrace,
          });
          return;
        }

        const previousEmoji = currentEmoji;
        await adapter.setReaction(nextEmoji);
        if (adapter.removeReaction && previousEmoji && previousEmoji !== nextEmoji) {
          await adapter.removeReaction(previousEmoji);
        }
        state = nextState;
        currentEmoji = nextEmoji;
        trackTransition({
          messageId,
          state: nextState,
          stage: "applied",
          emoji: nextEmoji,
          onTrace,
        });
      } catch (err) {
        state = fromState;
        trackTransition({
          messageId,
          state: nextState,
          stage: "failed",
          emoji: nextEmoji,
          onTrace,
        });
        onError?.(err);
      } finally {
        if (lastRequestedState === nextState) {
          lastRequestedState = null;
        }
      }
    });
    return chain;
  }

  return {
    enterWaiting: (hasPriorPendingWork: boolean): Promise<void> =>
      transition(hasPriorPendingWork ? "waiting-backlog" : "waiting-fresh"),
    enterActive: (): Promise<void> => transition("active"),
    complete: (succeeded: boolean): Promise<void> => transition(succeeded ? "done" : "error"),
    clearAfterHold: (holdMs = DISCORD_STATUS_CLEAR_HOLD_MS): void => {
      if (!enabled || clearTimer) {
        return;
      }
      clearTimer = setTimeout(() => {
        clearTimer = null;
        void transition("cleared");
      }, holdMs);
    },
  };
}

function resetTraceEntriesForTests(): void {
  traceEntries.length = 0;
}

function getTraceEntriesForTests(): DiscordStatusTraceEntry[] {
  return traceEntries.map((entry) => ({ ...entry }));
}

export const __testing = {
  getTraceEntriesForTests,
  resetTraceEntriesForTests,
};
