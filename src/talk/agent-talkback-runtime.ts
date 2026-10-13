/**
 * Debounced realtime voice talkback queue for delegated OpenClaw consults.
 *
 * Transcript fragments can arrive quickly while one consult is already running;
 * this queue batches compatible fragments, runs consults serially, and aborts
 * cleanly when the voice session closes.
 */
import type { RuntimeLogger } from "../plugins/runtime/types-core.js";

const MAX_PENDING_QUESTIONS = 32;
const MAX_PENDING_QUESTION_CHARS = 32 * 1024;

export type RealtimeVoiceAgentTalkbackResult = {
  text: string;
};

export type RealtimeVoiceAgentTalkbackQueue = {
  close(): void;
  enqueue(question: string, metadata?: unknown): void;
  isIdle(): boolean;
};

export type RealtimeVoiceAgentTalkbackQueueParams = {
  /** Delay used to merge nearby transcript fragments into one consult. */
  debounceMs: number;
  isStopped: () => boolean;
  logger: Pick<RuntimeLogger, "info" | "warn">;
  logPrefix: string;
  responseStyle: string;
  fallbackText: string;
  /** Delegates a batched question to OpenClaw and respects the abort signal. */
  consult: (args: {
    question: string;
    metadata?: unknown;
    responseStyle: string;
    signal: AbortSignal;
  }) => Promise<RealtimeVoiceAgentTalkbackResult>;
  /** Delivers final speakable text back to the realtime provider/session. */
  deliver: (text: string) => void;
};

type PendingQuestion = {
  question: string;
  metadata?: unknown;
};

export function createRealtimeVoiceAgentTalkbackQueue(
  params: RealtimeVoiceAgentTalkbackQueueParams,
): RealtimeVoiceAgentTalkbackQueue {
  let active = false;
  let closed = false;
  let pendingQuestions: PendingQuestion[] = [];
  let pendingQuestionChars = 0;
  let overflowWarned = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let activeAbortController: AbortController | undefined;

  const shouldStop = () => closed || params.isStopped();

  const clearDebounceTimer = () => {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  };

  const appendPendingQuestion = (next: PendingQuestion): boolean => {
    const current = pendingQuestions.at(-1);
    const mergeWithCurrent = current !== undefined && Object.is(current.metadata, next.metadata);
    const addedChars = next.question.length + (mergeWithCurrent ? 1 : 0);
    const exceedsQuestionLimit =
      !mergeWithCurrent && pendingQuestions.length >= MAX_PENDING_QUESTIONS;
    const exceedsCharacterLimit = pendingQuestionChars + addedChars > MAX_PENDING_QUESTION_CHARS;
    if (exceedsQuestionLimit || exceedsCharacterLimit) {
      if (!overflowWarned) {
        overflowWarned = true;
        params.logger.warn(
          `${params.logPrefix} consult queue full: droppedChars=${next.question.length} queued=${pendingQuestions.length} queuedChars=${pendingQuestionChars}`,
        );
      }
      return false;
    }
    if (current && mergeWithCurrent) {
      // Metadata identity represents the caller/context lane; merge only when the
      // same lane produced adjacent fragments.
      current.question = `${current.question}\n${next.question}`;
    } else {
      pendingQuestions.push(next);
    }
    pendingQuestionChars += addedChars;
    return true;
  };

  const shiftPendingQuestion = (): PendingQuestion | undefined => {
    const next = pendingQuestions.shift();
    if (!next) {
      return undefined;
    }
    pendingQuestionChars -= next.question.length;
    if (pendingQuestions.length === 0) {
      overflowWarned = false;
    }
    return next;
  };

  const clearPendingQuestions = () => {
    pendingQuestions = [];
    pendingQuestionChars = 0;
    overflowWarned = false;
  };

  const run = async (pending: PendingQuestion): Promise<void> => {
    if (shouldStop()) {
      return;
    }
    if (active) {
      appendPendingQuestion(pending);
      return;
    }
    active = true;
    let nextQuestion: PendingQuestion | undefined = pending;
    let consultStartedAt: number | undefined;
    try {
      while (nextQuestion) {
        if (shouldStop()) {
          return;
        }
        const currentQuestion = nextQuestion;
        consultStartedAt = Date.now();
        params.logger.info(
          `${params.logPrefix} consult: chars=${currentQuestion.question.length} queued=${pendingQuestions.length}`,
        );
        activeAbortController = new AbortController();
        const result = await params.consult({
          question: currentQuestion.question,
          metadata: currentQuestion.metadata,
          responseStyle: params.responseStyle,
          signal: activeAbortController.signal,
        });
        activeAbortController = undefined;
        const text = result.text.trim();
        params.logger.info(
          `${params.logPrefix} consult done: elapsedMs=${Date.now() - consultStartedAt} answerChars=${text.length} queued=${pendingQuestions.length}`,
        );
        if (!shouldStop() && text) {
          params.deliver(text);
        }
        nextQuestion = shiftPendingQuestion();
      }
    } catch (error) {
      activeAbortController = undefined;
      if (shouldStop() || isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const elapsedDetail =
        consultStartedAt === undefined ? "" : ` elapsedMs=${Date.now() - consultStartedAt}`;
      params.logger.warn(`${params.logPrefix} consult failed:${elapsedDetail} ${message}`);
      params.deliver(params.fallbackText);
    } finally {
      active = false;
      if (shouldStop()) {
        clearPendingQuestions();
      } else {
        const queuedQuestion = shiftPendingQuestion();
        if (queuedQuestion) {
          void run(queuedQuestion);
        }
      }
    }
  };

  return {
    isIdle: () => !active && pendingQuestions.length === 0,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      clearDebounceTimer();
      clearPendingQuestions();
      activeAbortController?.abort();
    },
    enqueue: (question, metadata) => {
      const trimmed = question.trim();
      if (!trimmed || shouldStop()) {
        return;
      }
      if (active) {
        if (appendPendingQuestion({ question: trimmed, metadata })) {
          params.logger.info(
            `${params.logPrefix} consult queued: chars=${trimmed.length} queued=${pendingQuestions.length}`,
          );
        }
        clearDebounceTimer();
        return;
      }
      if (!appendPendingQuestion({ question: trimmed, metadata })) {
        return;
      }
      clearDebounceTimer();
      // Debounce short transcript bursts so partial ASR fragments become a
      // single consult question instead of multiple back-to-back agent turns.
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        const queuedQuestion = shiftPendingQuestion();
        if (queuedQuestion && !shouldStop()) {
          void run(queuedQuestion);
        }
      }, params.debounceMs);
      debounceTimer.unref?.();
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
