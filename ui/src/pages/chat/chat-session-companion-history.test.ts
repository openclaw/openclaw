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
const exchange = (question: string, answer: string, ts: number) => ({ question, answer, ts });
const state = (threads: ChatSessionCompanionThreads) => threads.view("one");
const history = (threads: ChatSessionCompanionThreads) => state(threads).turns;
const hydrate = (threads: ChatSessionCompanionThreads, exchanges: ReturnType<typeof exchange>[]) =>
  threads.hydrate("one", async () => ({ exchanges }));
const questions = (threads: ChatSessionCompanionThreads) =>
  history(threads).map((turn) => turn.question);
const series = (length: number, prefix: string, answer: string, start = 1) =>
  Array.from({ length }, (_, index) => exchange(`${prefix} ${index}`, answer, start + index));
async function seed(
  threads: ChatSessionCompanionThreads,
  exchanges: ReturnType<typeof exchange>[],
) {
  for (const { question, answer, ts } of exchanges) {
    await threads.submit("one", question, answered(answer, ts));
  }
}
async function expectStableHistory(
  threads: ChatSessionCompanionThreads,
  exchanges: ReturnType<typeof exchange>[],
) {
  const before = history(threads).map((turn) => Object.assign({}, turn));
  await hydrate(threads, exchanges);
  expect(history(threads)).toEqual(before);
  await hydrate(threads, exchanges);
  expect(history(threads)).toEqual(before);
}

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
        const failed = history(threads)[0]!;
        expect(failed).toMatchObject({ status: "failed", attachments: [original] });
        expect(state(threads).attachments).toEqual([]);
        threads.setDraft("one", "My next question");
        threads.setAttachments("one", [next]);
        expect(threads.view("two").attachments).toEqual([]);
        if (settle === "retry") {
          const ask = vi.fn(answered("Recovered", 1));
          await threads.submit("one", failed, ask);
          expect(ask).toHaveBeenCalledWith("one", "Explain this image", [original]);
        } else {
          await hydrate(threads, [exchange("Explain this image", "Recovered", 1)]);
        }
        expect(state(threads)).toMatchObject({
          draft: "My next question",
          attachments: [next],
        });
        expect(getChatAttachmentDataUrl(original)).toBeNull();
        expect(getChatAttachmentDataUrl(next)).not.toBeNull();
        const reads = state(threads).attachmentReads!;
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

  it("reconciles a late answer into the earlier failed turn without consuming an old answer", async () => {
    const threads = new ChatSessionCompanionThreads();
    const old = exchange("A", "Old", 1);
    const later = exchange("B", "Later", 3);
    await hydrate(threads, [old]);
    await threads.submit("one", "A", unavailable);
    await threads.submit("one", "B", answered("Later", 3));
    await hydrate(threads, [old, later]);
    expect(history(threads).map((turn) => turn.status)).toEqual(["answered", "failed", "answered"]);
    await hydrate(threads, [old, exchange("A", "Recovered", 2), later]);
    expect(history(threads)).toMatchObject([
      { question: "A", status: "answered", answer: "Old" },
      { question: "A", status: "answered", answer: "Recovered" },
      { question: "B", status: "answered", answer: "Later" },
    ]);
  });

  it.each(["answered", "rejected"])(
    "waits for a pending %s request before associating its hydrated answer",
    async (settlement) => {
      const rejected = settlement === "rejected";
      const result = rejected ? { answer: "Committed", ts: 1 } : { answer: "New answer", ts: 2 };
      const threads = new ChatSessionCompanionThreads();
      if (!rejected) {
        await threads.submit("one", "A", unavailable);
      }
      const response = createDeferred<{ answer: string; ts: number }>();
      const pending = threads.submit("one", "A", () => response.promise);
      const blocked = vi.fn(answered("Must not be sent", 9));
      await threads.submit("one", "Another question", blocked);
      expect(blocked).not.toHaveBeenCalled();
      const load = vi.fn(async () => ({ exchanges: [{ question: "A", ...result }] }));
      const hydration = threads.hydrate("one", load);
      expect(load).not.toHaveBeenCalled();
      if (rejected) {
        response.reject(new Error("socket closed"));
      } else {
        expect(history(threads).map((turn) => turn.status)).toEqual(["failed", "pending"]);
        response.resolve(result);
      }
      await pending;
      await hydration;
      expect(load).toHaveBeenCalledOnce();
      if (!rejected) {
        await threads.hydrate("one", load);
      }
      expect(history(threads)).toMatchObject([
        ...(!rejected ? [{ question: "A", status: "failed" }] : []),
        { question: "A", status: "answered", answer: result.answer },
      ]);
    },
  );

  it.each(["pending", "answered"])(
    "retains a newer %s retry when an earlier Clear completes",
    async (settlement) => {
      const threads = new ChatSessionCompanionThreads();
      await threads.submit("one", "Retry this question", unavailable);
      const failed = history(threads)[0]!;
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
      expect(history(threads)).toMatchObject([
        { question: "Retry this question", status: settlement },
      ]);
      response.resolve({ answer: "Retried answer", ts: 2 });
      await retrying;
      await hydrate(threads, [exchange("Retry this question", "Retried answer", 2)]);
      expect(history(threads)).toMatchObject([
        { question: "Retry this question", answer: "Retried answer", status: "answered" },
      ]);
    },
  );

  it.each(["before-clear", "after-clear", "overlapping-clears"])(
    "settles hydration ordered %s without reviving cleared questions",
    async (order) => {
      const beforeClear = order === "before-clear";
      const overlapping = order === "overlapping-clears";
      const threads = new ChatSessionCompanionThreads();
      const response = createDeferred<{ answer: string; ts: number }>();
      const pending = overlapping
        ? threads.submit("one", "Earlier question", answered("Ready", 1))
        : threads.submit("one", beforeClear ? "A" : "Retired question", () => response.promise);
      if (overlapping) {
        await pending;
      }
      const load = vi.fn(async () => ({
        exchanges: beforeClear ? [{ question: "A", answer: "Late", ts: 1 }] : [],
      }));
      const earlierHydration = beforeClear ? threads.hydrate("one", load) : undefined;
      const clear = createDeferred<{ ok: true }>();
      const resetting = threads.reset("one", () => clear.promise);
      if (overlapping) {
        const second = createDeferred<{ ok: true }>();
        const clearingSecond = threads.reset("one", () => second.promise);
        second.resolve({ ok: true });
        await clearingSecond;
      }
      const hydration = earlierHydration ?? threads.hydrate("one", load);
      expect(load).not.toHaveBeenCalled();
      expect(state(threads).loading).toBe(true);
      clear.resolve({ ok: true });
      await resetting;
      if (beforeClear) {
        response.resolve({ answer: "Late", ts: 1 });
        await pending;
      }
      await hydration;
      expect(load).toHaveBeenCalledTimes(beforeClear ? 0 : 1);
      expect(state(threads)).toMatchObject({ turns: [], loading: false });
      if (!overlapping && !beforeClear) {
        response.resolve({ answer: "Late retired answer", ts: 1 });
        await pending;
        expect(history(threads)).toEqual([]);
      }
    },
  );

  it("does not reuse a separately answered question after an older retry and pruning", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "A", unavailable);
    const retry = history(threads)[0]!;
    const exchanges = series(23, "Later", "Known answer");
    exchanges[0]!.question = "A";
    await threads.submit("one", "A", answered("Known answer", 1));
    await seed(threads, exchanges.slice(1));
    const response = createDeferred<{ answer: string; ts: number }>();
    const pending = threads.submit("one", retry, () => response.promise);
    const retried = history(threads)[0]!;
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

  it.each(["append", "hydrate", "clock-rollback"])(
    "keeps a successful retry pruned by %s across repeated hydration",
    async (pruneBy) => {
      const threads = new ChatSessionCompanionThreads();
      await threads.submit("one", "A", unavailable);
      await threads.submit("one", "A", unavailable);
      const retry = history(threads)[0]!;
      const exchanges = series(22, "Answer", "Known");
      await seed(threads, exchanges);
      await threads.submit("one", retry, answered("Recovered A", 23));
      const recovered = history(threads)[0]!;
      exchanges.push(exchange("A", "Recovered A", 23));
      const load = async () => ({ exchanges });
      if (pruneBy === "append") {
        await threads.submit("one", "C", unavailable);
      } else {
        const remote = exchange("Remote", "New", 0);
        if (pruneBy === "hydrate") {
          exchanges.push({ ...remote, ts: 24 });
        } else {
          exchanges.splice(10, 0, remote);
        }
        await threads.hydrate("one", load);
        expect(questions(threads)).toContain("Remote");
      }
      expect(history(threads)[0]).toMatchObject({ question: "A", status: "failed" });
      expect(history(threads)).not.toContain(recovered);
      await expectStableHistory(threads, exchanges);
    },
  );

  it.each(["insert", "duplicate", "pruned"])(
    "keeps shared-history order without moving local failures: %s",
    async (mode) => {
      const insert = mode === "insert";
      const pruned = mode === "pruned";
      const threads = new ChatSessionCompanionThreads();
      const first = exchange("A", "First", 1);
      const last = insert ? exchange("D", "Last", 4) : first;
      const remote = insert
        ? [exchange("C", "Middle", 3)]
        : [exchange("X", "Other client", 2), exchange("Y", "Another shared answer", 3)];
      if (insert) {
        await hydrate(threads, [first]);
      } else {
        await threads.submit("one", first.question, answered(first.answer, first.ts));
        await threads.submit("one", last.question, answered(last.answer, last.ts));
      }
      const failures = pruned
        ? Array.from({ length: 24 }, (_, index) => `Failure ${index}`)
        : [insert ? "B" : "C"];
      for (const failure of failures) {
        await threads.submit("one", failure, unavailable);
      }
      if (insert) {
        await hydrate(threads, [first, last]);
      }
      const expected = pruned
        ? failures
        : insert
          ? ["A", "B", "C", "D"]
          : ["A", "X", "Y", last.question, "C"];
      const load = async () => ({ exchanges: [first, ...remote, last] });
      await threads.hydrate("one", load);
      expect(questions(threads)).toEqual(expected);
      await threads.hydrate("one", load);
      expect(questions(threads)).toEqual(expected);
    },
  );

  it.each(["old-answer", "same-key", "same-answer"])(
    "does not revive or reassign pruned responses: %s",
    async (mode) => {
      const threads = new ChatSessionCompanionThreads();
      const first = exchange("A", "First", 1);
      const last = { ...first, answer: mode === "same-key" ? "Second" : first.answer };
      const exchanges =
        mode === "old-answer"
          ? series(24, "Old", "Old answer")
          : mode === "same-key"
            ? [first, last]
            : [first, exchange("X", "Shared", 2), last];
      if (mode === "old-answer") {
        await hydrate(threads, exchanges);
        await threads.submit("one", "Old 0", unavailable);
      } else {
        await threads.submit("one", first.question, answered(first.answer, first.ts));
        await threads.submit("one", last.question, answered(last.answer, last.ts));
        for (let index = 0; index < 23; index += 1) {
          await threads.submit("one", `Failure ${index}`, unavailable);
        }
      }
      await expectStableHistory(threads, exchanges);
    },
  );

  it("recognizes a new identical response when Gateway pruning removes the oldest occurrence", async () => {
    const threads = new ChatSessionCompanionThreads();
    const repeated = exchange("A", "Repeated", 1);
    const middle = series(22, "Answer", "Known", 2);
    await hydrate(threads, [repeated, ...middle]);
    await threads.submit("one", "Local failure", unavailable);
    await threads.submit("one", repeated.question, answered(repeated.answer, repeated.ts));
    const load = async () => ({ exchanges: [...middle, repeated, repeated] });
    await threads.hydrate("one", load);
    expect(questions(threads)).toEqual([
      ...middle.slice(1).map((entry) => entry.question),
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
    await hydrate(threads, []);
    expect(questions(threads)).toEqual(["Original question", "New question"]);
    expect(state(threads).draft).toBe("Unsent draft");
    await threads.submit("one", "Answered before Clear", answered("Ready to clear", 2));
    threads.setDraft("one", "Unsent draft");
    await expect(
      threads.reset("one", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(questions(threads)).toEqual([
      "Original question",
      "New question",
      "Answered before Clear",
    ]);
    expect(state(threads).draft).toBe("Unsent draft");
    const stale = history(threads)[0]!;
    await threads.reset("one", async () => ({ ok: true }));
    const ask = vi.fn(answered("Must not be sent", 2));
    await threads.submit("one", stale, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(state(threads)).toMatchObject({ turns: [], draft: "" });
  });
});
