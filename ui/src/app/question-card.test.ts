// Tests the Control-UI question card store: parsing question.pending / list /
// resolved payloads and the enqueue/remove queue transitions.
import { describe, expect, it } from "vitest";
import {
  enqueueQuestionCard,
  parseQuestionPending,
  parseQuestionRemoved,
  removeQuestionCard,
  setQuestionQueueFromList,
  type QuestionPromptState,
} from "./question-card.ts";

const PENDING = {
  id: "rec-1",
  sessionKey: "s1",
  turnSourceChannel: "telegram",
  createdAtMs: 100,
  questions: [
    {
      id: "q1",
      header: "Deploy",
      question: "Ship it?",
      isOther: true,
      options: [{ label: "Yes (Recommended)" }, { label: "No", description: "hold" }],
    },
  ],
};

function makeState(): QuestionPromptState {
  return { client: null, questionQueue: [], questionBusy: false, questionError: null };
}

describe("question card store", () => {
  it("parses a question.pending payload into a card entry", () => {
    const entry = parseQuestionPending(PENDING);
    expect(entry).toEqual({
      id: "rec-1",
      sessionKey: "s1",
      turnSourceChannel: "telegram",
      createdAtMs: 100,
      questions: [
        {
          id: "q1",
          header: "Deploy",
          question: "Ship it?",
          isOther: true,
          isSecret: false,
          options: [{ label: "Yes (Recommended)" }, { label: "No", description: "hold" }],
        },
      ],
    });
  });

  it("rejects payloads with no valid questions", () => {
    expect(parseQuestionPending({ id: "x", questions: [] })).toBeNull();
    expect(parseQuestionPending({ id: "x", questions: [{ header: "h" }] })).toBeNull();
    expect(parseQuestionPending({ questions: [] })).toBeNull();
  });

  it("enqueues newest-first and de-dupes by id", () => {
    const state = makeState();
    enqueueQuestionCard(state, parseQuestionPending(PENDING)!);
    enqueueQuestionCard(
      state,
      parseQuestionPending({ ...PENDING, id: "rec-2", createdAtMs: 200 })!,
    );
    enqueueQuestionCard(
      state,
      parseQuestionPending({ ...PENDING, id: "rec-1", createdAtMs: 300 })!,
    );
    expect(state.questionQueue.map((q) => q.id)).toEqual(["rec-1", "rec-2"]);
    expect(state.questionQueue[0].createdAtMs).toBe(300);
  });

  it("removes a resolved/expired card by id", () => {
    const state = makeState();
    enqueueQuestionCard(state, parseQuestionPending(PENDING)!);
    const removed = parseQuestionRemoved({ id: "rec-1", reason: "gateway-restart" });
    expect(removed).toEqual({ id: "rec-1" });
    removeQuestionCard(state, removed!.id);
    expect(state.questionQueue).toEqual([]);
  });

  it("replaces the queue from a question.list response", () => {
    const state = makeState();
    setQuestionQueueFromList(state, {
      questions: [
        { ...PENDING, id: "a", createdAtMs: 1 },
        { ...PENDING, id: "b", createdAtMs: 2 },
      ],
    });
    expect(state.questionQueue.map((q) => q.id)).toEqual(["b", "a"]);
  });
});
