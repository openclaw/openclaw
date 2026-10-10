/**
 * Forced-consult dedupe coordinator for realtime voice sessions.
 *
 * The relay may synthesize an OpenClaw consult when the model hesitates, but a
 * native provider tool call can still arrive later. This coordinator prevents
 * duplicate consults and keeps late native calls correlated to forced handles.
 */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  matchRealtimeVoiceConsultQuestions,
  readRealtimeVoiceConsultQuestion,
} from "./consult-question.js";

const DEFAULT_REALTIME_VOICE_FORCED_CONSULT_NATIVE_DEDUPE_MS = 2_000;
const DEFAULT_REALTIME_VOICE_FORCED_CONSULT_LIMIT = 12;

/** Timer abstraction used so tests can inject deterministic fake timers. */
type RealtimeVoiceForcedConsultTimer = {
  clear(): void;
};

/** Coordinator tuning and injectable clock/timer/matcher hooks. */
export type RealtimeVoiceForcedConsultCoordinatorOptions = {
  limit?: number;
  /** Window for matching late native consults to forced consult handles. */
  nativeDedupeMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => RealtimeVoiceForcedConsultTimer;
  questionsMatch?: (left: string | undefined, right: string | undefined) => boolean;
};

/** Stable handle for one forced consult lifecycle. */
export type RealtimeVoiceForcedConsultHandle<TContext = unknown> = {
  id: string;
  question: string;
  context?: TContext;
};

/** Classification of a native provider consult relative to forced consult state. */
type RealtimeVoiceForcedConsultNativeMatch<TContext = unknown> =
  | { kind: "none"; question?: string }
  | { kind: "pending"; question?: string; handle: RealtimeVoiceForcedConsultHandle<TContext> }
  | { kind: "in_flight"; question?: string; handle: RealtimeVoiceForcedConsultHandle<TContext> }
  | {
      kind: "already_delivered";
      question?: string;
      handle: RealtimeVoiceForcedConsultHandle<TContext>;
    };

type RealtimeVoiceForcedConsultNativeRecentOptions = {
  /** Treat native calls without readable questions as recent generic consults. */
  allowUnknownQuestion?: boolean;
};

/** Public state machine for forced/native consult dedupe in a voice session. */
export type RealtimeVoiceForcedConsultCoordinator<TContext = unknown> = ReturnType<
  typeof createRealtimeVoiceForcedConsultCoordinator<TContext>
>;

type StoredForcedConsult<TContext> = {
  handle: RealtimeVoiceForcedConsultHandle<TContext>;
  nativeCallIds: Set<string>;
  questions: string[];
  pending: boolean;
  started: boolean;
  delivered: boolean;
  cancelled: boolean;
  timer?: RealtimeVoiceForcedConsultTimer;
  cleanupTimer?: RealtimeVoiceForcedConsultTimer;
};

type RecentNativeConsult = {
  question?: string;
  at: number;
};

/** Create an in-memory forced-consult coordinator for one realtime session. */
export function createRealtimeVoiceForcedConsultCoordinator<TContext = unknown>(
  options: RealtimeVoiceForcedConsultCoordinatorOptions = {},
) {
  const state = new Map<string, StoredForcedConsult<TContext>>();
  const recentNativeConsults: RecentNativeConsult[] = [];
  let nextId = 0;
  const now = options.now ?? Date.now;
  const limit = options.limit ?? DEFAULT_REALTIME_VOICE_FORCED_CONSULT_LIMIT;
  const nativeDedupeMs =
    options.nativeDedupeMs ?? DEFAULT_REALTIME_VOICE_FORCED_CONSULT_NATIVE_DEDUPE_MS;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return { clear: () => clearTimeout(timer) };
    });
  const questionsMatch = options.questionsMatch ?? matchRealtimeVoiceConsultQuestions;

  const stopPending = (stored: StoredForcedConsult<TContext>) => {
    stored.timer?.clear();
    stored.timer = undefined;
    stored.pending = false;
  };

  const scheduleCleanup = (stored: StoredForcedConsult<TContext>) => {
    stored.cleanupTimer?.clear();
    // Delivered/cancelled handles remain visible briefly so late provider tool
    // calls can be matched and suppressed instead of spoken twice.
    stored.cleanupTimer = setTimer(() => {
      if (state.get(stored.handle.id) === stored) {
        state.delete(stored.handle.id);
      }
    }, nativeDedupeMs);
  };

  const prune = () => {
    const earliestRecentNative = now() - nativeDedupeMs;
    for (let index = recentNativeConsults.length - 1; index >= 0; index -= 1) {
      const recent = recentNativeConsults[index];
      if (recent && recent.at < earliestRecentNative) {
        recentNativeConsults.splice(index, 1);
      }
    }
    while (recentNativeConsults.length > limit) {
      recentNativeConsults.shift();
    }
    while (state.size > limit) {
      const first = state.values().next().value;
      if (!first) {
        return;
      }
      // Bound memory/timer use for long calls with repeated forced consults.
      first.timer?.clear();
      first.cleanupTimer?.clear();
      state.delete(first.handle.id);
    }
  };

  const matchesQuestion = (stored: StoredForcedConsult<TContext>, question: string | undefined) =>
    stored.questions.some((candidate) => questionsMatch(candidate, question));

  const findMatching = (question: string | undefined) =>
    question
      ? [...state.values()].findLast((candidate) => matchesQuestion(candidate, question))
      : undefined;

  const rememberStoredQuestion = (
    stored: StoredForcedConsult<TContext>,
    question: string | undefined,
  ) => {
    const trimmed = question?.trim();
    if (!trimmed) {
      return;
    }
    if (stored.questions.some((candidate) => questionsMatch(candidate, trimmed))) {
      return;
    }
    // Provider rewrites can use prompt/query aliases; remembering all observed
    // question variants improves later dedupe matching.
    stored.questions.push(trimmed);
  };

  const recordRecentNativeConsult = (question: string | undefined) => {
    recentNativeConsults.push({ question, at: now() });
    prune();
  };

  const getStored = (handle: RealtimeVoiceForcedConsultHandle<TContext>) => state.get(handle.id);

  return {
    prepare(question: string, prepareOptions?: { context?: TContext; id?: string }) {
      const trimmed = question.trim();
      if (!trimmed) {
        return undefined;
      }
      const id = prepareOptions?.id ?? `forced-consult:${now()}:${++nextId}`;
      const existing = state.get(id);
      if (existing) {
        existing.timer?.clear();
        existing.cleanupTimer?.clear();
      }
      const handle: RealtimeVoiceForcedConsultHandle<TContext> = {
        id,
        question: trimmed,
        ...(prepareOptions && "context" in prepareOptions
          ? { context: prepareOptions.context }
          : {}),
      };
      state.set(handle.id, {
        handle,
        nativeCallIds: new Set(),
        questions: [trimmed],
        pending: true,
        started: false,
        delivered: false,
        cancelled: false,
      });
      prune();
      return handle;
    },
    schedule(
      handle: RealtimeVoiceForcedConsultHandle<TContext>,
      delayMs: number,
      run: (handle: RealtimeVoiceForcedConsultHandle<TContext>) => void,
    ) {
      const stored = getStored(handle);
      if (!stored || !stored.pending || stored.timer) {
        return;
      }
      stored.timer = setTimer(
        () => {
          stored.timer = undefined;
          if (state.get(handle.id) === stored && stored.pending && !stored.cancelled) {
            run(handle);
          }
        },
        // Clamp pathological delays before they reach Node timer APIs.
        resolveTimerTimeoutMs(delayMs, 0, 0),
      );
    },
    clearPending() {
      for (const stored of state.values()) {
        if (stored.pending) {
          stopPending(stored);
          state.delete(stored.handle.id);
        }
      }
    },
    consumePending(question?: string) {
      const pendingCandidates = [...state.values()].filter((candidate) => candidate.pending);
      // If there is exactly one pending forced consult, allow callers that do
      // not have readable question text to consume it unambiguously.
      const stored =
        !question && pendingCandidates.length === 1
          ? pendingCandidates[0]
          : pendingCandidates.findLast((candidate) => matchesQuestion(candidate, question));
      if (!stored?.pending) {
        return undefined;
      }
      stopPending(stored);
      return stored.handle;
    },
    cancelPending(handle: RealtimeVoiceForcedConsultHandle<TContext>) {
      const stored = getStored(handle);
      if (!stored?.pending) {
        return;
      }
      stopPending(stored);
      state.delete(handle.id);
    },
    recordNativeConsult(
      args: unknown,
      nativeCallId?: string,
    ): RealtimeVoiceForcedConsultNativeMatch<TContext> {
      const question = readRealtimeVoiceConsultQuestion(args);
      recordRecentNativeConsult(question);
      // Native calls win over scheduled forced calls when they match a pending
      // question; the pending timer is cleared and the handle remains for dedupe.
      const pending = [...state.values()].findLast(
        (candidate) => candidate.pending && matchesQuestion(candidate, question),
      );
      if (pending) {
        // Clear the timer before matcher callbacks; publish the consumed state afterward.
        pending.timer?.clear();
        pending.timer = undefined;
        rememberStoredQuestion(pending, question);
        if (nativeCallId) {
          pending.nativeCallIds.add(nativeCallId);
        }
        pending.pending = false;
        scheduleCleanup(pending);
        return { kind: "pending", question, handle: pending.handle };
      }
      const stored = findMatching(question);
      if (!stored) {
        return { kind: "none", question };
      }
      if (nativeCallId) {
        stored.nativeCallIds.add(nativeCallId);
      }
      rememberStoredQuestion(stored, question);
      if (stored.cancelled || stored.delivered) {
        return { kind: "already_delivered", question, handle: stored.handle };
      }
      if (stored.started) {
        return { kind: "in_flight", question, handle: stored.handle };
      }
      return { kind: "none", question };
    },
    markStarted(handle: RealtimeVoiceForcedConsultHandle<TContext>) {
      const stored = getStored(handle);
      if (!stored) {
        return;
      }
      stopPending(stored);
      stored.started = true;
    },
    markDelivered(handle: RealtimeVoiceForcedConsultHandle<TContext>) {
      const stored = getStored(handle);
      if (!stored) {
        return;
      }
      stopPending(stored);
      stored.started = true;
      stored.delivered = true;
      scheduleCleanup(stored);
    },
    markCancelled(handle: RealtimeVoiceForcedConsultHandle<TContext>) {
      const stored = getStored(handle);
      if (!stored || stored.delivered) {
        return;
      }
      stopPending(stored);
      stored.cancelled = true;
      scheduleCleanup(stored);
    },
    isCancelled(handle: RealtimeVoiceForcedConsultHandle<TContext>) {
      return getStored(handle)?.cancelled === true;
    },
    nativeCallIds(handle: RealtimeVoiceForcedConsultHandle<TContext>): readonly string[] {
      return [...(getStored(handle)?.nativeCallIds ?? [])];
    },
    handles(): readonly RealtimeVoiceForcedConsultHandle<TContext>[] {
      return [...state.values()].map((stored) => stored.handle);
    },
    rememberQuestion(handle: RealtimeVoiceForcedConsultHandle<TContext>, question: string) {
      const stored = getStored(handle);
      if (stored) {
        rememberStoredQuestion(stored, question);
      }
    },
    findRecent(question: string) {
      prune();
      return findMatching(question)?.handle;
    },
    hasRecent(question: string) {
      return Boolean(findMatching(question));
    },
    hasRecentNativeConsult(
      question: string,
      recentOptions: RealtimeVoiceForcedConsultNativeRecentOptions = {},
    ) {
      prune();
      return recentNativeConsults
        .toReversed()
        .some((recent) =>
          recent.question
            ? questionsMatch(recent.question, question)
            : recentOptions.allowUnknownQuestion === true,
        );
    },
    remove(handle: RealtimeVoiceForcedConsultHandle<TContext>) {
      const stored = getStored(handle);
      stored?.timer?.clear();
      stored?.cleanupTimer?.clear();
      state.delete(handle.id);
    },
    clear() {
      for (const stored of state.values()) {
        stored.timer?.clear();
        stored.cleanupTimer?.clear();
      }
      state.clear();
      recentNativeConsults.length = 0;
    },
  };
}
