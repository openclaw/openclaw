// Application-owned ask_user_question card parsing and queue state.
//
// Mirrors the exec-approval prompt state (queue + busy + error) but simpler:
// questions have no default expiry, so there are no expiry timers. The card is
// removed when the gateway broadcasts question.resolved / question.expired.
import { normalizeOptionalString } from "../lib/string-coerce.ts";

export type QuestionCardOption = {
  label: string;
  description?: string;
};

export type QuestionCardQuestion = {
  id: string;
  header: string;
  question: string;
  options: QuestionCardOption[];
  isOther: boolean;
  isSecret: boolean;
};

export type QuestionCardEntry = {
  id: string;
  sessionKey: string | null;
  turnSourceChannel: string | null;
  createdAtMs: number;
  questions: QuestionCardQuestion[];
};

/** Answers keyed by question id, matching the question.resolve wire shape. */
export type QuestionCardAnswers = Record<string, { text: string }>;

export type QuestionPromptState = {
  client: {
    request(method: string, params?: unknown): Promise<unknown>;
  } | null;
  questionQueue: QuestionCardEntry[];
  questionBusy: boolean;
  questionError: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOptions(value: unknown): QuestionCardOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((raw) => {
    if (!isRecord(raw)) {
      return [];
    }
    const label = normalizeOptionalString(raw.label);
    if (!label) {
      return [];
    }
    const description = normalizeOptionalString(raw.description);
    return [description ? { label, description } : { label }];
  });
}

function parseQuestion(value: unknown): QuestionCardQuestion | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeOptionalString(value.id);
  const header = normalizeOptionalString(value.header);
  const question = normalizeOptionalString(value.question);
  if (!id || !header || !question) {
    return null;
  }
  return {
    id,
    header,
    question,
    options: parseOptions(value.options),
    isOther: value.isOther === true,
    isSecret: value.isSecret === true,
  };
}

/** Parses a question.pending event payload (or a question.list entry) into a card. */
export function parseQuestionPending(payload: unknown): QuestionCardEntry | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = normalizeOptionalString(payload.id);
  if (!id || !Array.isArray(payload.questions)) {
    return null;
  }
  const questions = payload.questions
    .map(parseQuestion)
    .filter((question): question is QuestionCardQuestion => question !== null);
  if (questions.length === 0) {
    return null;
  }
  return {
    id,
    sessionKey: normalizeOptionalString(payload.sessionKey) ?? null,
    turnSourceChannel: normalizeOptionalString(payload.turnSourceChannel) ?? null,
    createdAtMs: typeof payload.createdAtMs === "number" ? payload.createdAtMs : Date.now(),
    questions,
  };
}

/** Parses a question.resolved / question.expired event payload to its id. */
export function parseQuestionRemoved(payload: unknown): { id: string } | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = normalizeOptionalString(payload.id);
  return id ? { id } : null;
}

function sortNewestFirst(queue: QuestionCardEntry[]): QuestionCardEntry[] {
  return queue.toSorted((a, b) => b.createdAtMs - a.createdAtMs);
}

/** Adds (or replaces) a pending question card, newest first. */
export function enqueueQuestionCard(state: QuestionPromptState, entry: QuestionCardEntry): void {
  const next = state.questionQueue.filter((item) => item.id !== entry.id);
  next.push(entry);
  state.questionQueue = sortNewestFirst(next);
  state.questionError = null;
}

/** Removes a resolved/expired question card and clears a stale error. */
export function removeQuestionCard(state: QuestionPromptState, id: string): void {
  const activeId = state.questionQueue[0]?.id ?? null;
  state.questionQueue = state.questionQueue.filter((entry) => entry.id !== id);
  if (activeId !== (state.questionQueue[0]?.id ?? null)) {
    state.questionError = null;
  }
}

/** Replaces the queue from a question.list response (visibility-filtered by the gateway). */
export function setQuestionQueueFromList(state: QuestionPromptState, payload: unknown): void {
  const questions = isRecord(payload) && Array.isArray(payload.questions) ? payload.questions : [];
  const parsed = questions
    .map(parseQuestionPending)
    .filter((entry): entry is QuestionCardEntry => entry !== null);
  state.questionQueue = sortNewestFirst(parsed);
}
