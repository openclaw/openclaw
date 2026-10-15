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

  it.each(["follow-up", "retry"])(
    "retains failed turns in order while a %s is pending and answered",
    async (mode) => {
      const retry = mode === "retry";
      const names = retry
        ? ["Same question", "Different question", "Same question"]
        : ["Earlier question", "Original question", "New question"];
      const statuses = retry ? ["pending", "failed", "failed"] : ["answered", "failed", "pending"];
      const selected = retry ? 0 : 2;
      const answer = retry ? "First recovered" : "Recovered";
      const threads = new ChatSessionCompanionThreads();
      for (const [index, question] of names.slice(0, retry ? 3 : 2).entries()) {
        await threads.submit(
          "one",
          question,
          !retry && index === 0 ? answered("Ready", 1) : unavailable,
        );
      }
      const response = createDeferred<{ answer: string; ts: number }>();
      const ask = vi.fn(() => response.promise);
      const pending = threads.submit("one", retry ? threads.view("one").turns[0]! : names[2]!, ask);
      expect(ask).toHaveBeenCalledWith("one", names[selected], undefined);
      expect(questions(threads)).toEqual(names);
      expect(threads.view("one").turns.map((turn) => turn.status)).toEqual(statuses);
      const blocked = vi.fn(answered("Must not be sent", 9));
      await threads.submit("one", "Another question", blocked);
      expect(blocked).not.toHaveBeenCalled();
      response.resolve({ answer, ts: 2 });
      await pending;
      expect(threads.view("one").turns).toMatchObject(
        names.map((question, index) =>
          index === selected
            ? { question, status: "answered", answer }
            : { question, status: statuses[index] },
        ),
      );
    },
  );

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
      const load = vi.fn(async () => ({ exchanges: [{ question: "A", ...result }] }));
      const hydration = threads.hydrate("one", load);
      expect(load).not.toHaveBeenCalled();
      if (rejected) {
        response.reject(new Error("socket closed"));
      } else {
        expect(threads.view("one").turns.map((turn) => turn.status)).toEqual(["failed", "pending"]);
        response.resolve(result);
      }
      await pending;
      await hydration;
      expect(load).toHaveBeenCalledOnce();
      if (!rejected) {
        await threads.hydrate("one", load);
      }
      expect(threads.view("one").turns).toMatchObject([
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
      expect(threads.view("one").loading).toBe(true);
      clear.resolve({ ok: true });
      await resetting;
      if (beforeClear) {
        response.resolve({ answer: "Late", ts: 1 });
        await pending;
      }
      await hydration;
      expect(load).toHaveBeenCalledTimes(beforeClear ? 0 : 1);
      expect(threads.view("one")).toMatchObject({ turns: [], loading: false });
      if (!overlapping && !beforeClear) {
        response.resolve({ answer: "Late retired answer", ts: 1 });
        await pending;
        expect(threads.view("one").turns).toEqual([]);
      }
    },
  );

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

  it.each(["append", "hydrate", "clock-rollback"])(
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
          ts: 0,
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

  it.each(["insert", "duplicate", "pruned"])(
    "keeps shared-history order without moving local failures: %s",
    async (mode) => {
      const insert = mode === "insert";
      const pruned = mode === "pruned";
      const threads = new ChatSessionCompanionThreads();
      const first = { question: "A", answer: "First", ts: 1 };
      const last = insert ? { question: "D", answer: "Last", ts: 4 } : first;
      const remote = insert
        ? [{ question: "C", answer: "Middle", ts: 3 }]
        : [
            { question: "X", answer: "Other client", ts: 2 },
            { question: "Y", answer: "Another shared answer", ts: 3 },
          ];
      if (insert) {
        await threads.hydrate("one", async () => ({ exchanges: [first] }));
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
        await threads.hydrate("one", async () => ({ exchanges: [first, last] }));
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
      const first = { question: "A", answer: "First", ts: 1 };
      const last = { ...first, answer: mode === "same-key" ? "Second" : first.answer };
      const exchanges =
        mode === "old-answer"
          ? Array.from({ length: 24 }, (_, index) => ({
              question: `Old ${index}`,
              answer: "Old answer",
              ts: index + 1,
            }))
          : mode === "same-key"
            ? [first, last]
            : [first, { question: "X", answer: "Shared", ts: 2 }, last];
      if (mode === "old-answer") {
        await threads.hydrate("one", async () => ({ exchanges }));
        await threads.submit("one", "Old 0", unavailable);
      } else {
        await threads.submit("one", first.question, answered(first.answer, first.ts));
        await threads.submit("one", last.question, answered(last.answer, last.ts));
        for (let index = 0; index < 23; index += 1) {
          await threads.submit("one", `Failure ${index}`, unavailable);
        }
      }
      const before = threads.view("one").turns.map((turn) => Object.assign({}, turn));
      const load = async () => ({ exchanges });
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
