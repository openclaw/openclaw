import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { ChatSessionCompanionThreads } from "./chat-session-companion.ts";

const unavailable = async () => {
  throw new Error("Side chat timed out.");
};
const answered = (answer: string, ts: number) => async () => ({ answer, ts });
const questions = (threads: ChatSessionCompanionThreads) =>
  threads.view("one").turns.map((turn) => turn.question);

describe("Side chat turn history", () => {
  it.each(["retry", "hydrate"])(
    "retains a failed image until %s succeeds without taking a newer draft",
    async (settle) => {
      const threads = new ChatSessionCompanionThreads();
      const image = (id: string) =>
        registerChatAttachmentPayload({
          attachment: { id, mimeType: "image/png", fileName: id },
          dataUrl: "data:image/png;base64,aW1hZ2U=",
          file: new File(["image"], id, { type: "image/png" }),
        });
      const original = image("original.png");
      const next = image("next.png");
      try {
        threads.setAttachments("one", [original]);
        await threads.submit("one", "Explain this image", unavailable);
        const failed = threads.view("one").turns[0]!;
        expect(failed).toMatchObject({ status: "failed", attachments: [original] });
        expect(threads.view("one").attachments).toEqual([]);
        threads.setDraft("one", "My next question");
        threads.setAttachments("one", [next]);
        expect(threads.view("two").attachments).toEqual([]);
        if (settle === "retry") {
          const ask = vi.fn(answered("Recovered", 1));
          await threads.submit("one", failed, ask);
          expect(ask).toHaveBeenCalledWith("one", "Explain this image", [original]);
        } else {
          await threads.hydrate("one", async () => ({
            exchanges: [{ question: "Explain this image", answer: "Recovered", ts: 1 }],
          }));
        }
        expect(threads.view("one")).toMatchObject({
          draft: "My next question",
          attachments: [next],
        });
        expect(getChatAttachmentDataUrl(original)).toBeNull();
        expect(getChatAttachmentDataUrl(next)).not.toBeNull();
        const reads = threads.view("one").attachmentReads!;
        const signal = reads.readSignal;
        reads.updatePending(signal, 1);
        const blocked = vi.fn(answered("Must not send unread input", 2));
        await threads.submit("one", "My next question", blocked);
        expect(blocked).not.toHaveBeenCalled();
        threads.retire("one");
        expect(signal.aborted).toBe(true);
        expect(getChatAttachmentDataUrl(next)).toBeNull();
      } finally {
        threads.retire();
      }
    },
  );

  it("retains failed questions in order while a different follow-up is pending and answered", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "Earlier question", answered("Ready", 1));
    await threads.submit("one", "Original question", unavailable);
    const response = createDeferred<{ answer: string; ts: number }>();
    const pending = threads.submit("one", "New question", () => response.promise);
    expect(questions(threads)).toEqual(["Earlier question", "Original question", "New question"]);
    expect(threads.view("one").turns.map((turn) => turn.status)).toEqual([
      "answered",
      "failed",
      "pending",
    ]);
    const blocked = vi.fn(answered("Must not be sent", 9));
    await threads.submit("one", "Another question", blocked);
    expect(blocked).not.toHaveBeenCalled();
    response.resolve({ answer: "Recovered", ts: 2 });
    await pending;
    expect(threads.view("one").turns).toMatchObject([
      { question: "Earlier question", status: "answered" },
      { question: "Original question", status: "failed" },
      { question: "New question", status: "answered", answer: "Recovered" },
    ]);
  });

  it("retries the selected failure in place even when another turn has the same question", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "Same question", unavailable);
    await threads.submit("one", "Different question", unavailable);
    await threads.submit("one", "Same question", unavailable);
    const selected = threads.view("one").turns[0]!;
    const response = createDeferred<{ answer: string; ts: number }>();
    const ask = vi.fn(() => response.promise);
    const pending = threads.submit("one", selected, ask);
    expect(ask).toHaveBeenCalledWith("one", "Same question", undefined);
    expect(questions(threads)).toEqual(["Same question", "Different question", "Same question"]);
    expect(threads.view("one").turns.map((turn) => turn.status)).toEqual([
      "pending",
      "failed",
      "failed",
    ]);
    response.resolve({ answer: "First recovered", ts: 2 });
    await pending;
    expect(threads.view("one").turns).toMatchObject([
      { question: "Same question", status: "answered", answer: "First recovered" },
      { question: "Different question", status: "failed" },
      { question: "Same question", status: "failed" },
    ]);
  });

  it("reconciles a late answer into the earlier failed turn without consuming an old answer", async () => {
    const threads = new ChatSessionCompanionThreads();
    const old = { question: "A", answer: "Old", ts: 1 };
    await threads.hydrate("one", async () => ({ exchanges: [old] }));
    await threads.submit("one", "A", unavailable);
    await threads.submit("one", "B", answered("Later", 3));
    await threads.hydrate("one", async () => ({
      exchanges: [old, { question: "B", answer: "Later", ts: 3 }],
    }));
    expect(threads.view("one").turns.map((turn) => turn.status)).toEqual([
      "answered",
      "failed",
      "answered",
    ]);
    await threads.hydrate("one", async () => ({
      exchanges: [
        old,
        { question: "A", answer: "Recovered", ts: 2 },
        { question: "B", answer: "Later", ts: 3 },
      ],
    }));
    expect(threads.view("one").turns).toMatchObject([
      { question: "A", status: "answered", answer: "Old" },
      { question: "A", status: "answered", answer: "Recovered" },
      { question: "B", status: "answered", answer: "Later" },
    ]);
  });

  it("waits for the pending same-text request before associating its hydrated answer", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "A", unavailable);
    const response = createDeferred<{ answer: string; ts: number }>();
    const pending = threads.submit("one", "A", () => response.promise);
    const load = async () => ({ exchanges: [{ question: "A", answer: "New answer", ts: 2 }] });
    const hydration = threads.hydrate("one", load);
    expect(threads.view("one").turns.map((turn) => turn.status)).toEqual(["failed", "pending"]);
    response.resolve({ answer: "New answer", ts: 2 });
    await pending;
    await hydration;
    await threads.hydrate("one", load);
    expect(threads.view("one").turns).toMatchObject([
      { question: "A", status: "failed" },
      { question: "A", status: "answered", answer: "New answer" },
    ]);
  });

  it("recovers a committed answer when a pending request rejects before hydration", async () => {
    const threads = new ChatSessionCompanionThreads();
    const response = createDeferred<{ answer: string; ts: number }>();
    const pending = threads.submit("one", "A", () => response.promise);
    const load = vi.fn(async () => ({
      exchanges: [{ question: "A", answer: "Committed", ts: 1 }],
    }));
    const hydration = threads.hydrate("one", load);
    expect(load).not.toHaveBeenCalled();
    response.reject(new Error("socket closed"));
    await pending;
    await hydration;
    expect(load).toHaveBeenCalledOnce();
    expect(threads.view("one").turns).toMatchObject([
      { question: "A", status: "answered", answer: "Committed" },
    ]);
  });

  it("retires hydration waiting for an answer when the thread is cleared", async () => {
    const threads = new ChatSessionCompanionThreads();
    const response = createDeferred<{ answer: string; ts: number }>();
    const pending = threads.submit("one", "A", () => response.promise);
    const load = vi.fn(async () => ({ exchanges: [{ question: "A", answer: "Late", ts: 1 }] }));
    const hydration = threads.hydrate("one", load);
    await threads.reset("one", async () => ({ ok: true }));
    response.resolve({ answer: "Late", ts: 1 });
    await pending;
    await hydration;
    expect(load).not.toHaveBeenCalled();
    expect(threads.view("one").turns).toEqual([]);
  });

  it.each(["pending", "answered"])(
    "retains a newer %s retry when an earlier Clear completes",
    async (settlement) => {
      const threads = new ChatSessionCompanionThreads();
      await threads.submit("one", "Retry this question", unavailable);
      const failed = threads.view("one").turns[0]!;
      const clear = createDeferred<{ ok: true }>();
      const resetting = threads.reset("one", () => clear.promise);
      const response = createDeferred<{ answer: string; ts: number }>();
      const retrying = threads.submit("one", failed, () => response.promise);
      if (settlement === "answered") {
        response.resolve({ answer: "Retried answer", ts: 2 });
        await retrying;
      }
      clear.resolve({ ok: true });
      await resetting;
      expect(threads.view("one").turns).toMatchObject([
        { question: "Retry this question", status: settlement },
      ]);
      response.resolve({ answer: "Retried answer", ts: 2 });
      await retrying;
      await threads.hydrate("one", async () => ({
        exchanges: [{ question: "Retry this question", answer: "Retried answer", ts: 2 }],
      }));
      expect(threads.view("one").turns).toMatchObject([
        { question: "Retry this question", answer: "Retried answer", status: "answered" },
      ]);
    },
  );

  it("releases history waiting on an ask retired by a pending Clear", async () => {
    const threads = new ChatSessionCompanionThreads();
    const response = createDeferred<{ answer: string; ts: number }>();
    const pending = threads.submit("one", "Retired question", () => response.promise);
    const clear = createDeferred<{ ok: true }>();
    const resetting = threads.reset("one", () => clear.promise);
    const load = vi.fn(async () => ({ exchanges: [] }));
    const hydration = threads.hydrate("one", load);
    expect(load).not.toHaveBeenCalled();
    clear.resolve({ ok: true });
    await resetting;
    await hydration;
    expect(load).toHaveBeenCalledOnce();
    expect(threads.view("one")).toMatchObject({ turns: [], loading: false });
    response.resolve({ answer: "Late retired answer", ts: 1 });
    await pending;
    expect(threads.view("one").turns).toEqual([]);
  });

  it("waits for every overlapping clear before loading new history", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "Earlier question", answered("Ready", 1));
    const first = createDeferred<{ ok: true }>();
    const second = createDeferred<{ ok: true }>();
    const clearingFirst = threads.reset("one", () => first.promise);
    const clearingSecond = threads.reset("one", () => second.promise);
    second.resolve({ ok: true });
    await clearingSecond;
    const load = vi.fn(async () => ({ exchanges: [] }));
    const hydration = threads.hydrate("one", load);
    expect(load).not.toHaveBeenCalled();
    expect(threads.view("one").loading).toBe(true);
    first.resolve({ ok: true });
    await clearingFirst;
    await hydration;
    expect(load).toHaveBeenCalledOnce();
    expect(threads.view("one")).toMatchObject({ turns: [], loading: false });
  });

  it("does not reuse a separately answered question after an older retry and pruning", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "A", unavailable);
    const retry = threads.view("one").turns[0]!;
    const exchanges = Array.from({ length: 23 }, (_, index) => ({
      question: index === 0 ? "A" : `Later ${index}`,
      answer: "Known answer",
      ts: index + 1,
    }));
    await threads.submit("one", "A", answered("Known answer", 1));
    for (const exchange of exchanges.slice(1)) {
      await threads.submit("one", exchange.question, answered(exchange.answer, exchange.ts));
    }
    const response = createDeferred<{ answer: string; ts: number }>();
    const pending = threads.submit("one", retry, () => response.promise);
    const retried = threads.view("one").turns[0]!;
    const load = async () => ({
      exchanges: [...exchanges, { question: "Remote", answer: "New remote answer", ts: 24 }],
    });
    const hydration = threads.hydrate("one", load);
    await Promise.resolve();
    response.reject(new Error("offline"));
    await pending;
    await hydration;
    await threads.hydrate("one", load);
    expect(retried.status).toBe("failed");
    expect(questions(threads).filter((question) => question === "A")).toHaveLength(1);
  });

  it.each(["append", "hydrate", "interleaved", "clock-rollback"])(
    "keeps a successful retry pruned by %s across repeated hydration",
    async (pruneBy) => {
      const threads = new ChatSessionCompanionThreads();
      await threads.submit("one", "A", unavailable);
      await threads.submit("one", "A", unavailable);
      const retry = threads.view("one").turns[0]!;
      const exchanges = Array.from({ length: 22 }, (_, index) => ({
        question: `Answer ${index}`,
        answer: "Known",
        ts: index + 1,
      }));
      for (const exchange of exchanges) {
        await threads.submit("one", exchange.question, answered(exchange.answer, exchange.ts));
      }
      await threads.submit("one", retry, answered("Recovered A", 23));
      const recovered = threads.view("one").turns[0]!;
      exchanges.push({ question: "A", answer: "Recovered A", ts: 23 });
      const load = async () => ({ exchanges });
      if (pruneBy === "append") {
        await threads.submit("one", "C", unavailable);
      } else {
        const remote = {
          question: "Remote",
          answer: "New",
          ts: pruneBy === "clock-rollback" ? 0 : 10.5,
        };
        if (pruneBy === "hydrate") {
          exchanges.push({ ...remote, ts: 24 });
        } else {
          exchanges.splice(10, 0, remote);
        }
        await threads.hydrate("one", load);
        expect(questions(threads)).toContain("Remote");
      }
      const before = threads.view("one").turns.map((turn) => Object.assign({}, turn));
      expect(before[0]).toMatchObject({ question: "A", status: "failed" });
      expect(threads.view("one").turns).not.toContain(recovered);
      await threads.hydrate("one", load);
      expect(threads.view("one").turns).toEqual(before);
      await threads.hydrate("one", load);
      expect(threads.view("one").turns).toEqual(before);
    },
  );

  it.each([1, 24])("does not revive pruned answers after %i new failures", async (count) => {
    const threads = new ChatSessionCompanionThreads();
    const exchanges = Array.from({ length: 24 }, (_, index) => ({
      question: `Old ${index}`,
      answer: "Old answer",
      ts: index + 1,
    }));
    await threads.hydrate("one", async () => ({ exchanges }));
    for (let index = 0; index < count; index += 1) {
      await threads.submit("one", index === 0 ? "Old 0" : `New ${index}`, unavailable);
    }
    const before = threads
      .view("one")
      .turns.map((turn) => ({ question: turn.question, status: turn.status }));
    await threads.hydrate("one", async () => ({ exchanges }));
    expect(
      threads.view("one").turns.map((turn) => ({ question: turn.question, status: turn.status })),
    ).toEqual(before);
  });

  it("inserts newly hydrated answers around existing answers without moving local failures", async () => {
    const threads = new ChatSessionCompanionThreads();
    const first = { question: "A", answer: "First", ts: 1 };
    const last = { question: "D", answer: "Last", ts: 4 };
    await threads.hydrate("one", async () => ({ exchanges: [first] }));
    await threads.submit("one", "B", unavailable);
    await threads.hydrate("one", async () => ({ exchanges: [first, last] }));
    await threads.hydrate("one", async () => ({
      exchanges: [first, { question: "C", answer: "Middle", ts: 3 }, last],
    }));
    expect(questions(threads)).toEqual(["A", "B", "C", "D"]);
  });

  it("preserves duplicate answered exchanges on repeated hydration", async () => {
    const threads = new ChatSessionCompanionThreads();
    const exchange = { question: "A", answer: "Repeated", ts: 1 };
    const load = async () => ({ exchanges: [exchange, exchange] });
    await threads.hydrate("one", async () => ({ exchanges: [exchange] }));
    await threads.hydrate("one", load);
    await threads.submit("one", "B", unavailable);
    await threads.hydrate("one", load);
    expect(questions(threads)).toEqual(["A", "A", "B"]);
  });

  it.each([
    { duplicates: false, pruned: false },
    { duplicates: true, pruned: false },
    { duplicates: false, pruned: true },
    { duplicates: true, pruned: true },
  ])(
    "keeps shared-history order with duplicate identities=$duplicates and pruned anchors=$pruned",
    async ({ duplicates, pruned }) => {
      const threads = new ChatSessionCompanionThreads();
      const first = { question: "A", answer: "First", ts: 1 };
      const remote = [
        { question: "X", answer: "Other client", ts: 2 },
        { question: "Y", answer: "Another shared answer", ts: 3 },
      ];
      const last = duplicates ? first : { question: "B", answer: "Last", ts: 4 };
      await threads.submit("one", first.question, answered(first.answer, first.ts));
      await threads.submit("one", last.question, answered(last.answer, last.ts));
      const failures = pruned
        ? Array.from({ length: 24 }, (_, index) => `Failure ${index}`)
        : ["C"];
      for (const failure of failures) {
        await threads.submit("one", failure, unavailable);
      }
      const expected = pruned ? failures : ["A", "X", "Y", last.question, "C"];
      const load = async () => ({ exchanges: [first, ...remote, last] });
      await threads.hydrate("one", load);
      expect(questions(threads)).toEqual(expected);
      await threads.hydrate("one", load);
      expect(questions(threads)).toEqual(expected);
    },
  );

  it.each([false, true])(
    "retains the correct response after pruning a key collision (identical answers: %s)",
    async (identical) => {
      const threads = new ChatSessionCompanionThreads();
      const first = { question: "A", answer: "First", ts: 1 };
      const last = { ...first, answer: identical ? first.answer : "Second" };
      await threads.submit("one", first.question, answered(first.answer, first.ts));
      await threads.submit("one", last.question, answered(last.answer, last.ts));
      for (let index = 0; index < 23; index += 1) {
        await threads.submit("one", `Failure ${index}`, unavailable);
      }
      const before = threads.view("one").turns.map((turn) => Object.assign({}, turn));
      const load = async () => ({
        exchanges: identical
          ? [first, { question: "X", answer: "Shared", ts: 2 }, last]
          : [first, last],
      });
      await threads.hydrate("one", load);
      expect(threads.view("one").turns).toEqual(before);
      await threads.hydrate("one", load);
      expect(threads.view("one").turns).toEqual(before);
    },
  );

  it("recognizes a new identical response when Gateway pruning removes the oldest occurrence", async () => {
    const threads = new ChatSessionCompanionThreads();
    const repeated = { question: "A", answer: "Repeated", ts: 1 };
    const middle = Array.from({ length: 22 }, (_, index) => ({
      question: `Answer ${index}`,
      answer: "Known",
      ts: index + 2,
    }));
    await threads.hydrate("one", async () => ({ exchanges: [repeated, ...middle] }));
    await threads.submit("one", "Local failure", unavailable);
    await threads.submit("one", repeated.question, answered(repeated.answer, repeated.ts));
    const load = async () => ({ exchanges: [...middle, repeated, repeated] });
    await threads.hydrate("one", load);
    expect(questions(threads)).toEqual([
      ...middle.slice(1).map((exchange) => exchange.question),
      "Local failure",
      "A",
      "A",
    ]);
    await threads.hydrate("one", load);
    expect(questions(threads).slice(-3)).toEqual(["Local failure", "A", "A"]);
  });

  it("keeps failures and draft through empty hydration and clears everything on explicit reset", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "Earlier question", answered("Ready", 1));
    await threads.submit("one", "Original question", unavailable);
    await threads.submit("one", "New question", unavailable);
    threads.setDraft("one", "Unsent draft");
    await threads.hydrate("one", async () => ({ exchanges: [] }));
    expect(questions(threads)).toEqual(["Original question", "New question"]);
    expect(threads.view("one").draft).toBe("Unsent draft");
    const stale = threads.view("one").turns[0]!;
    await threads.reset("one", async () => ({ ok: true }));
    const ask = vi.fn(answered("Must not be sent", 2));
    await threads.submit("one", stale, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(threads.view("one")).toMatchObject({ turns: [], draft: "" });
  });

  it("caps mixed history at 24 turns and retains an active retry through hydration", async () => {
    const threads = new ChatSessionCompanionThreads();
    for (let index = 0; index < 30; index += 1) {
      await threads.submit(
        "one",
        `Question ${index}`,
        index % 2 ? answered("Answer", index) : unavailable,
      );
    }
    expect(questions(threads)).toEqual(
      Array.from({ length: 24 }, (_, index) => `Question ${index + 6}`),
    );
    const response = createDeferred<{ answer: string; ts: number }>();
    const pending = threads.submit("one", threads.view("one").turns[0]!, () => response.promise);
    const hydration = threads.hydrate("one", async () => ({
      exchanges: [
        ...Array.from({ length: 23 }, (_, index) => ({
          question: `Remote ${index}`,
          answer: "Remote answer",
          ts: 100 + index,
        })),
        { question: "Question 6", answer: "Recovered", ts: 200 },
      ],
    }));
    expect(threads.view("one").turns).toHaveLength(24);
    expect(threads.view("one").turns[0]).toMatchObject({
      question: "Question 6",
      status: "pending",
    });
    response.resolve({ answer: "Recovered", ts: 200 });
    await pending;
    await hydration;
    expect(threads.view("one").turns).toHaveLength(24);
    expect(threads.view("one").turns.find((turn) => turn.question === "Question 6")).toMatchObject({
      question: "Question 6",
      status: "answered",
      answer: "Recovered",
    });
  });
});
