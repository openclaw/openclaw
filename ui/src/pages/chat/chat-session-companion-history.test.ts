import { describe, expect, it } from "vitest";
import {
  ChatSessionCompanionThreads,
  sessionCompanionDisplayTurns,
} from "./chat-session-companion.ts";

const unavailable = async () => {
  throw Object.assign(new Error("Side chat timed out."), {
    details: { reason: "unavailable" },
    retryable: false,
  });
};
const answered = (answer: string, ts: number) => async () => ({ answer, ts });
const questions = (threads: ChatSessionCompanionThreads) =>
  sessionCompanionDisplayTurns(threads.view("one")).map((turn) => turn.question);

describe("Side chat failed-question history", () => {
  it("keeps unanswered questions in order across follow-ups and repeated failures", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "Earlier answer", answered("Ready", 1));
    await threads.submit("one", "Original question", unavailable);
    let reject!: (error: Error) => void;
    const next = threads.submit(
      "one",
      "retry",
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    expect(questions(threads)).toEqual(["Earlier answer", "Original question"]);
    expect(threads.view("one").pendingQuestion).toBe("retry");
    reject(new Error("socket closed"));
    await next;
    await threads.submit("one", "New question", answered("Recovered", 2));
    expect(questions(threads)).toEqual([
      "Earlier answer",
      "Original question",
      "retry",
      "New question",
    ]);
    await threads.hydrate("one", async () => ({ exchanges: threads.view("one").exchanges }));
    expect(questions(threads)).toEqual([
      "Earlier answer",
      "Original question",
      "retry",
      "New question",
    ]);
    expect(threads.view("one").exchanges).toHaveLength(2);
  });

  it("updates an explicit retry in place without duplicating the failed question", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "Original question", unavailable);
    await threads.submit("one", "Original question", unavailable);
    expect(questions(threads)).toEqual([]);
    expect(threads.view("one").failedQuestion).toBe("Original question");
    await threads.submit("one", "Original question", answered("Recovered", 1));
    expect(questions(threads)).toEqual(["Original question"]);
    expect(threads.view("one").failedQuestion).toBeNull();
  });

  it.each([{ history: ["A", "A"] }, { history: ["A", "B", "A"] }])(
    "keeps one failed attempt after the final answered exchange in $history",
    async ({ history }) => {
      const threads = new ChatSessionCompanionThreads();
      await threads.hydrate("one", async () => ({
        exchanges: history.map((question) => ({ question, answer: "Answered", ts: 1 })),
      }));
      await threads.submit("one", "Failed", unavailable);
      await threads.submit("one", "Next", answered("Recovered", 2));
      expect(questions(threads)).toEqual([...history, "Failed", "Next"]);
    },
  );

  it("does not erase earlier failed attempts when later answers repeat their question", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "B", unavailable);
    await threads.submit("one", "C", unavailable);
    await threads.submit("one", "B", unavailable);
    await threads.submit("one", "D", answered("Last", 4));
    const answer = { question: "B", answer: "A later answer", ts: 3 };
    const last = { question: "D", answer: "Last", ts: 4 };
    await threads.hydrate("one", async () => ({ exchanges: [answer, last] }));
    const turns = sessionCompanionDisplayTurns(threads.view("one"));
    expect(turns.filter((turn) => "hint" in turn).map((turn) => turn.question)).toEqual([
      "B",
      "C",
      "B",
    ]);
    expect(threads.view("one").exchanges).toEqual([answer, last]);
  });

  it("keeps a failed question's position when exact Retry follows an unrelated hydrated answer", async () => {
    const threads = new ChatSessionCompanionThreads();
    const first = { question: "A", answer: "First", ts: 1 };
    const later = { question: "C", answer: "Another answer", ts: 3 };
    await threads.submit("one", "A", answered(first.answer, first.ts));
    await threads.submit("one", "B", unavailable);
    await threads.hydrate("one", async () => ({ exchanges: [first, later] }));
    await threads.submit("one", "B", unavailable);
    await threads.submit("one", "D", answered("Last", 4));
    expect(questions(threads)).toEqual(["A", "B", "C", "D"]);
  });

  it("keeps local failed questions through empty hydration but retires them on explicit clear", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "Earlier answer", answered("Ready", 1));
    await threads.submit("one", "Original question", unavailable);
    await threads.submit("one", "New question", answered("Later answer", 2));
    threads.setDraft("one", "Unsent draft");
    await threads.hydrate("one", async () => ({ exchanges: [] }));
    expect(questions(threads)).toEqual(["Original question"]);
    expect(threads.view("one").draft).toBe("Unsent draft");
    await threads.reset("one", async () => ({ ok: true }));
    expect(questions(threads)).toEqual([]);
  });

  it.each([0, 24])(
    "bounds local failed-question history with %i repeated answers",
    async (count) => {
      const threads = new ChatSessionCompanionThreads();
      await threads.hydrate("one", async () => ({
        exchanges: Array.from({ length: count }, () => ({
          question: "A",
          answer: "Answered",
          ts: 1,
        })),
      }));
      for (let index = 0; index < 30; index += 1) {
        await threads.submit("one", "Question " + index, unavailable);
      }
      expect(questions(threads)).toEqual([
        ...Array.from({ length: count }, () => "A"),
        ...Array.from({ length: 24 }, (_, index) => "Question " + (index + 5)),
      ]);
      expect(threads.view("one").failedQuestion).toBe("Question 29");
    },
  );
});
