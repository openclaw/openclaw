/* @vitest-environment jsdom */
import { render } from "lit";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { DurableQuestionDraft } from "../../../lib/chat/composer-draft-store.runtime.ts";
import {
  createAsyncQuestionPanelProps,
  createAsyncQuestionPresentation,
  renderAsyncQuestionSummary,
} from "./chat-async-question.ts";
import { getTranscriptState, resetThreadPresentation } from "./chat-thread-interactions.ts";

const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), toast: vi.fn() }));
vi.mock("../../../lib/toast.ts", () => ({ showToast: storage.toast }));
vi.mock("../../../lib/chat/composer-draft-store.runtime.ts", () => ({
  readDurableComposerDraft: storage.read,
  writeDurableComposerDraft: storage.write,
}));
const question = {
  itemId: "audience",
  questions: [{ title: "Which audience?", options: ["Everyone"] }],
};
const owner = {
  gatewayOwner: "ws://fixture",
  recoveryScope: "person-a",
  scopeKey: "chat:v3:agent:main:one\u0000agent:main",
};
const props = {
  sessionKey: "agent:main:one",
  connectionEpoch: 1,
  asyncQuestionStorage: owner,
  messages: [{ role: "assistant", openclawAsyncDelivery: question }],
  onAsyncQuestionSubmit: vi.fn(async () => true),
};
function state(): Parameters<typeof createAsyncQuestionPresentation>[0] {
  return {
    asyncQuestionDrafts: new Map(),
    asyncQuestionRevision: 0,
    transcriptRenderContext: { onAsyncQuestionSubmit: props.onAsyncQuestionSubmit },
  };
}
async function settled(current: ReturnType<typeof state>) {
  for (const session of current.asyncQuestionSessions?.values() ?? []) {
    await session.load;
    await session.write;
  }
}
function edit(presentation: ReturnType<typeof createAsyncQuestionPresentation>, text: string) {
  const panel = createAsyncQuestionPanelProps(question, presentation, {});
  panel.model.drafts.set("0", { selected: new Set(), freeText: text });
  panel.onChange?.();
}
const saved: DurableQuestionDraft = {
  itemId: question.itemId,
  signature: JSON.stringify(question.questions),
  edited: true,
  answers: [{ selected: [], freeText: "Saved answer" }],
};
beforeEach(() => {
  storage.read.mockReset().mockResolvedValue({ status: "not-found" });
  storage.write.mockReset().mockResolvedValue({ status: "persisted" });
  props.onAsyncQuestionSubmit.mockClear();
  storage.toast.mockClear();
});

it("preserves an edited draft across reconnect and session navigation without retargeting old callbacks", async () => {
  const current = state();
  const initial = createAsyncQuestionPresentation(current, props);
  edit(initial, "My team");
  await settled(current);
  const reconnected = createAsyncQuestionPresentation(current, { ...props, connectionEpoch: 2 });
  expect(reconnected.drafts.get(question.itemId)?.answers.get("0")?.freeText).toBe("My team");
  expect(await initial.submit?.("stale answer")).toBe(false);
  const other = createAsyncQuestionPresentation(current, {
    ...props,
    sessionKey: "agent:main:two",
    asyncQuestionStorage: { ...owner, scopeKey: "chat:v3:agent:main:two\u0000agent:main" },
  });
  expect(other.drafts.get(question.itemId)?.answers.get("0")?.freeText).toBe("");
  const returned = createAsyncQuestionPresentation(current, { ...props, connectionEpoch: 3 });
  expect(returned.drafts.get(question.itemId)?.answers.get("0")?.freeText).toBe("My team");
  expect(await initial.submit?.("old scope returned")).toBe(false);
  expect(storage.write).toHaveBeenCalledWith(
    { ...owner, scopeKey: `questions:v1:${owner.scopeKey}` },
    expect.objectContaining({
      questionDrafts: [
        expect.objectContaining({ answers: [{ selected: [], freeText: "My team" }] }),
      ],
    }),
    expect.objectContaining({ expectedRevision: 0 }),
  );
});

it("restores a remounted draft only for the authenticated owner and matching question content", async () => {
  storage.read.mockImplementation(async (scope) =>
    scope.recoveryScope === owner.recoveryScope
      ? { status: "found", draft: { revision: 10, writeId: "saved", questionDrafts: [saved] } }
      : { status: "not-found" },
  );
  const current = state();
  createAsyncQuestionPresentation(current, props);
  await settled(current);
  expect(current.asyncQuestionDrafts.get(question.itemId)?.answers.get("0")?.freeText).toBe(
    "Saved answer",
  );
  createAsyncQuestionPresentation(current, {
    ...props,
    asyncQuestionStorage: { ...owner, recoveryScope: "person-b" },
  });
  await settled(current);
  expect(current.asyncQuestionDrafts.get(question.itemId)?.answers.get("0")?.freeText).toBe("");
  const reused = state();
  createAsyncQuestionPresentation(reused, {
    ...props,
    messages: [
      {
        role: "assistant",
        openclawAsyncDelivery: { ...question, questions: [{ title: "Different question?" }] },
      },
    ],
  });
  await settled(reused);
  expect(reused.asyncQuestionDrafts.get(question.itemId)?.answers.get("0")?.freeText).toBe("");
});

it("never overwrites a new edit with late hydration and writes against the observed revision", async () => {
  const pending = createDeferred<unknown>();
  storage.read.mockReturnValue(pending.promise);
  const current = state();
  const presentation = createAsyncQuestionPresentation(current, props);
  edit(presentation, "Newer answer");
  pending.resolve({
    status: "found",
    draft: { revision: 12, writeId: "previous", questionDrafts: [saved] },
  });
  await settled(current);
  expect(current.asyncQuestionDrafts.get(question.itemId)?.answers.get("0")?.freeText).toBe(
    "Newer answer",
  );
  expect(storage.write).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      questionDrafts: [
        expect.objectContaining({ answers: [{ selected: [], freeText: "Newer answer" }] }),
      ],
    }),
    expect.objectContaining({ expectedRevision: 12, expectedWriteId: "previous" }),
  );
});

it("keeps a draft usable and explains unavailable persistence without claiming it was saved", async () => {
  storage.read.mockResolvedValue({ status: "storage-failed" });
  const current = state();
  edit(createAsyncQuestionPresentation(current, props), "Keep my answer");
  await settled(current);
  const presentation = createAsyncQuestionPresentation(current, props);
  expect(presentation.storageError).toContain("not saved");
  expect(presentation.drafts.get(question.itemId)?.answers.get("0")?.freeText).toBe(
    "Keep my answer",
  );
  expect(storage.write).not.toHaveBeenCalled();
});

it("does not resurrect a private draft when hydration finishes after persistence is disabled", async () => {
  const pending = createDeferred<unknown>();
  storage.read.mockReturnValue(pending.promise);
  const current = state();
  edit(createAsyncQuestionPresentation(current, props), "Do not persist");
  const session = [...current.asyncQuestionSessions!.values()][0]!;
  createAsyncQuestionPresentation(current, { ...props, asyncQuestionStorage: null });
  pending.resolve({ status: "not-found", revision: 100, writeId: "retired" });
  await session.load;
  await session.write;
  expect(storage.write).not.toHaveBeenCalled();
  expect(current.asyncQuestionDrafts.get(question.itemId)?.answers.get("0")?.freeText).not.toBe(
    "Do not persist",
  );
});

it("does not turn a reopened but untouched question into an edited draft on reload", async () => {
  storage.read.mockResolvedValue({
    status: "found",
    draft: {
      revision: 10,
      writeId: "saved",
      questionDrafts: [{ ...saved, edited: false, reopenedAfterBoundary: "earlier-completion" }],
    },
  });
  const current = state();
  createAsyncQuestionPresentation(current, props);
  await settled(current);
  expect(current.asyncQuestionDrafts.get(question.itemId)?.edited).toBe(false);
});

it("keeps a dismissed answer out of pending questions after reload and later completion", async () => {
  let stored = { revision: 10, writeId: "saved", questionDrafts: [saved] };
  storage.read.mockImplementation(async () => ({ status: "found", draft: stored }));
  storage.write.mockImplementation(async (_scope, draft, options) => {
    stored = { ...draft, writeId: options.writeId };
    return { status: "persisted" };
  });
  const current = state();
  const presentation = createAsyncQuestionPresentation(current, props);
  await settled(current);

  await createAsyncQuestionPanelProps(question, presentation, {}).onSkip?.();
  await settled(current);

  expect(stored.questionDrafts).toEqual([{ ...saved, dismissed: true }]);
  expect(props.onAsyncQuestionSubmit).not.toHaveBeenCalled();
  const remounted = state();
  const laterProps = {
    ...props,
    messages: [
      ...props.messages,
      { role: "user", content: "Continue with the default", __openclaw: { id: "next", seq: 2 } },
      { role: "assistant", content: "Done", phase: "final_answer", stopReason: "stop" },
    ],
  };
  createAsyncQuestionPresentation(remounted, laterProps);
  await settled(remounted);
  const recovered = createAsyncQuestionPresentation(remounted, laterProps);
  expect(recovered.pending).toEqual([]);
  expect(recovered.archived.has(question.itemId)).toBe(true);
  expect(recovered.drafts.get(question.itemId)).toMatchObject({ status: "skipped", edited: true });
  expect(recovered.drafts.get(question.itemId)?.answers.get("0")?.freeText).toBe("Saved answer");
});

it.each(["storage-failed", "conflict"])(
  "does not retry identical failed retirement on each render (%s)",
  async (status) => {
    storage.read.mockResolvedValue({
      status: "found",
      draft: { revision: 10, writeId: "saved", questionDrafts: [saved] },
    });
    storage.write.mockResolvedValue({ status });
    const current = state();
    const answeredProps = {
      ...props,
      messages: [
        ...props.messages,
        {
          role: "user",
          content: "> Which audience?\n\nEveryone",
          __openclaw: { id: "answer", seq: 2 },
        },
      ],
    };
    createAsyncQuestionPresentation(current, answeredProps);
    await settled(current);
    // Storage completion causes a render; follow-up renders must not repeat failed I/O.
    for (let index = 0; index < 3; index += 1) {
      createAsyncQuestionPresentation(current, answeredProps);
      await settled(current);
    }
    expect(storage.write).toHaveBeenCalledOnce();
  },
);

it("fences edits made before a deletion tombstone arrives in a delayed first read", async () => {
  const pending = createDeferred<unknown>();
  storage.read.mockReturnValue(pending.promise);
  const current = state();
  edit(createAsyncQuestionPresentation(current, props), "Older than deletion");
  const session = [...current.asyncQuestionSessions!.values()][0]!;
  pending.resolve({
    status: "not-found",
    revision: session.intentRevision! + 1,
    writeId: "retired:session",
  });
  await session.load;
  await session.write;
  expect(storage.write).not.toHaveBeenCalled();
  expect(session.drafts.size).toBe(0);
});

it("retires disposed-pane callbacks without renewing pre-deletion draft intent", async () => {
  const pendingRead = createDeferred<unknown>();
  const pendingSend = createDeferred<boolean>();
  storage.read.mockReturnValue(pendingRead.promise);
  const current = getTranscriptState("disposed-question");
  current.transcriptRenderContext.onAsyncQuestionSubmit = () => pendingSend.promise;
  const presentation = createAsyncQuestionPresentation(current, props);
  edit(presentation, "Before pane disposal");
  const panel = createAsyncQuestionPanelProps(question, presentation, {});
  const sending = Promise.resolve(panel.onSubmit?.({ "0": ["Before pane disposal"] })).catch(
    () => undefined,
  );
  const session = [...current.asyncQuestionSessions!.values()][0]!;
  const beforeDisposal = session.intentRevision!;
  resetThreadPresentation("disposed-question");
  pendingSend.reject(new Error("Disposed send"));
  await sending;
  expect(session.intentRevision).toBe(beforeDisposal);
  pendingRead.resolve({
    status: "not-found",
    revision: beforeDisposal + 1,
    writeId: "retired:deleted",
  });
  await session.load;
  await session.write;
  expect(storage.write).not.toHaveBeenCalled();
});

it("durably dismisses only the optional question and offers Undo without sending or cancelling work", async () => {
  const current = state();
  const presentation = createAsyncQuestionPresentation(current, props);
  edit(presentation, "Keep this answer for later");
  await presentation.dismiss(question.itemId);
  expect(createAsyncQuestionPresentation(current, props).pending).toHaveLength(0);
  const stored = storage.write.mock.calls.at(-1)?.[1];
  expect(stored.questionDrafts).toEqual([
    expect.objectContaining({
      dismissed: true,
      answers: [{ selected: [], freeText: "Keep this answer for later" }],
    }),
  ]);
  expect(props.onAsyncQuestionSubmit).not.toHaveBeenCalled();
  const undo = storage.toast.mock.calls.at(-1)?.[0];
  expect(undo.actionLabel).toBe("Undo");
  undo.onAction();
  await settled(current);
  expect(createAsyncQuestionPresentation(current, props).pending).toHaveLength(1);
  expect(current.asyncQuestionDrafts.get(question.itemId)?.answers.get("0")?.freeText).toBe(
    "Keep this answer for later",
  );
  expect(storage.write.mock.calls.at(-1)?.[1].questionDrafts[0].dismissed).toBeUndefined();

  storage.read.mockResolvedValue({
    status: "found",
    draft: {
      revision: stored.revision,
      writeId: "dismissed",
      questionDrafts: stored.questionDrafts,
    },
  });
  const remounted = state();
  createAsyncQuestionPresentation(remounted, { ...props, connectionEpoch: 2 });
  await settled(remounted);
  const restored = createAsyncQuestionPresentation(remounted, { ...props, connectionEpoch: 2 });
  expect(restored.pending).toHaveLength(0);
  void restored.reopen(question.itemId);
  await settled(remounted);
  expect(
    createAsyncQuestionPresentation(remounted, { ...props, connectionEpoch: 2 }).pending,
  ).toHaveLength(1);
  expect(remounted.asyncQuestionDrafts.get(question.itemId)?.answers.get("0")?.freeText).toBe(
    "Keep this answer for later",
  );
  expect(props.onAsyncQuestionSubmit).not.toHaveBeenCalled();
});

it("makes a failed dismissal save visible and keeps Undo available", async () => {
  storage.write.mockResolvedValue({ status: "storage-failed" });
  const current = state();
  const presentation = createAsyncQuestionPresentation(current, props);
  await presentation.dismiss(question.itemId);
  const toast = storage.toast.mock.calls.at(-1)?.[0];
  expect(toast.message).toContain("not saved");
  expect(toast.actionLabel).toBe("Undo");
  toast.onAction();
  await settled(current);
  expect(createAsyncQuestionPresentation(current, props).pending).toHaveLength(1);
});

it("reopens from Undo against the latest completion boundary, not the dismissed render", async () => {
  const current = state();
  const initial = {
    ...props,
    messages: [{ ...props.messages[0], runId: "original-run" }],
  };
  await createAsyncQuestionPresentation(current, initial).dismiss(question.itemId);
  const undo = storage.toast.mock.calls.at(-1)?.[0];
  const advanced = {
    ...initial,
    messages: [
      ...initial.messages,
      ...["original-run", "successor-run"].map((runId, index) => ({
        role: "assistant",
        runId,
        phase: "final_answer",
        stopReason: "stop",
        content: "Finished the requested work.",
        __openclaw: { id: `final-${runId}`, seq: index + 2, runTerminal: true },
      })),
    ],
  };
  expect(createAsyncQuestionPresentation(current, advanced).pending).toHaveLength(0);
  undo.onAction();
  await settled(current);
  const reopened = createAsyncQuestionPresentation(current, advanced);
  expect(reopened.pending.map((entry) => entry.itemId)).toEqual([question.itemId]);
  expect(reopened.drafts.get(question.itemId)?.edited).not.toBe(true);
  expect(props.onAsyncQuestionSubmit).not.toHaveBeenCalled();
});

it.each(["reopened", "answered"])(
  "does not announce a delayed dismissal after the question was %s",
  async (outcome) => {
    const pendingWrite = createDeferred<unknown>();
    storage.write.mockReturnValue(pendingWrite.promise);
    const current = state();
    const presentation = createAsyncQuestionPresentation(current, props);
    await settled(current);
    const dismissal = presentation.dismiss(question.itemId);
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledOnce());
    if (outcome === "reopened") {
      void presentation.reopen(question.itemId);
    } else {
      createAsyncQuestionPresentation(current, {
        ...props,
        messages: [
          ...props.messages,
          {
            role: "user",
            content: "> Which audience?\n\nEveryone",
            __openclaw: { id: "canonical-answer", seq: 2 },
          },
        ],
      });
    }
    pendingWrite.resolve({ status: "persisted" });
    await dismissal;
    await settled(current);
    expect(storage.toast).not.toHaveBeenCalled();
  },
);

it.each(["gatewayOwner", "recoveryScope"] as const)(
  "rereads retired drafts after a direct authenticated owner switch (%s)",
  async (ownerField) => {
    storage.read
      .mockResolvedValueOnce({
        status: "found",
        draft: { revision: 10, writeId: "saved-a", questionDrafts: [saved] },
      })
      .mockResolvedValueOnce({ status: "not-found" })
      .mockResolvedValueOnce({ status: "not-found", revision: 20, writeId: "retired-a" });
    const current = state();
    createAsyncQuestionPresentation(current, props);
    await settled(current);
    expect(current.asyncQuestionDrafts.get(question.itemId)?.answers.get("0")?.freeText).toBe(
      "Saved answer",
    );
    createAsyncQuestionPresentation(current, {
      ...props,
      asyncQuestionStorage: { ...owner, [ownerField]: "different-owner" },
    });
    await settled(current);
    // The first identity is retired while another authenticated owner is active.
    // Returning to it must read current storage, not revive a cached loaded map.
    createAsyncQuestionPresentation(current, props);
    await settled(current);
    const restored = createAsyncQuestionPresentation(current, props);
    expect(restored.drafts.get(question.itemId)?.answers.get("0")?.freeText).toBe("");
    expect(storage.read).toHaveBeenCalledTimes(3);
    expect(storage.write).not.toHaveBeenCalled();
  },
);

it.each(["gatewayOwner", "recoveryScope"] as const)(
  "fences pending hydration writes after a direct authenticated owner switch (%s)",
  async (ownerField) => {
    const pending = createDeferred<unknown>();
    storage.read.mockReturnValueOnce(pending.promise).mockResolvedValue({ status: "not-found" });
    const current = state();
    edit(createAsyncQuestionPresentation(current, props), "Previous owner's unfinished answer");
    const previousSession = [...current.asyncQuestionSessions!.values()][0]!;
    createAsyncQuestionPresentation(current, {
      ...props,
      asyncQuestionStorage: { ...owner, [ownerField]: "different-owner" },
    });
    pending.resolve({ status: "not-found" });
    await previousSession.load;
    await previousSession.write;
    expect(storage.write).not.toHaveBeenCalled();
    expect(previousSession.invalidated).toBe(true);
    expect(current.asyncQuestionDrafts.get(question.itemId)?.answers.get("0")?.freeText).toBe("");
  },
);

it.each(["Undo", "Answer"])(
  "keeps %s visibly pending until removing dismissal survives a remount",
  async (action) => {
    const onReopen = vi.fn();
    const activeProps = { ...props, onReopen };
    const current = state();
    const initial = createAsyncQuestionPresentation(current, activeProps);
    edit(initial, "Keep this answer for later");
    await initial.dismiss(question.itemId);
    const writesBeforeReopen = storage.write.mock.calls.length;
    let stored = storage.write.mock.calls.at(-1)![1];
    storage.read.mockImplementation(async () => ({
      status: "found",
      draft: { ...stored, writeId: "committed" },
    }));
    const pendingWrite = createDeferred();
    storage.write.mockImplementation(async (_scope, record) => {
      await pendingWrite.promise;
      stored = record;
      return { status: "persisted" };
    });
    const dismissed = createAsyncQuestionPresentation(current, activeProps);
    if (action === "Undo") {
      storage.toast.mock.calls.at(-1)![0].onAction();
    } else {
      void dismissed.reopen(question.itemId);
    }
    const restoring = createAsyncQuestionPresentation(current, activeProps);
    expect(restoring.pending).toHaveLength(0);
    expect(onReopen).not.toHaveBeenCalled();
    const summary = document.createElement("div");
    render(renderAsyncQuestionSummary(question, restoring), summary);
    expect(summary.textContent).toContain("Restoring answer");
    expect(summary.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    render(null, summary);

    // Establish that the reopening transaction has reached its held write before
    // mounting a second reader; this is the delayed commit boundary under test.
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledTimes(writesBeforeReopen + 1));
    // Reload before the transaction commits still reads dismissed, not a claimed restore.
    const duringSave = state();
    createAsyncQuestionPresentation(duringSave, activeProps);
    await settled(duringSave);
    expect(createAsyncQuestionPresentation(duringSave, activeProps).pending).toHaveLength(0);
    pendingWrite.resolve();
    await settled(current);
    await vi.waitFor(() => expect(onReopen).toHaveBeenCalledOnce());
    const reloaded = state();
    createAsyncQuestionPresentation(reloaded, activeProps);
    await settled(reloaded);
    const recovered = createAsyncQuestionPresentation(reloaded, activeProps);
    expect(recovered.pending).toHaveLength(1);
    expect(recovered.drafts.get(question.itemId)?.answers.get("0")?.freeText).toBe(
      "Keep this answer for later",
    );
    expect(props.onAsyncQuestionSubmit).not.toHaveBeenCalled();
  },
);

it("does not reopen a canonically answered question when its restoration save finishes", async () => {
  storage.read.mockResolvedValue({
    status: "found",
    draft: { revision: 10, writeId: "dismissed", questionDrafts: [{ ...saved, dismissed: true }] },
  });
  const onReopen = vi.fn();
  const activeProps = { ...props, onReopen };
  const current = state();
  createAsyncQuestionPresentation(current, activeProps);
  await settled(current);
  const pendingWrite = createDeferred<unknown>();
  storage.write.mockReturnValue(pendingWrite.promise);
  const reopening = createAsyncQuestionPresentation(current, activeProps).reopen(question.itemId);
  await vi.waitFor(() => expect(storage.write).toHaveBeenCalledOnce());
  const answeredProps = {
    ...activeProps,
    messages: [
      ...props.messages,
      {
        role: "user",
        content: "> Which audience?\n\nEveryone",
        __openclaw: { id: "canonical-answer", seq: 2 },
      },
    ],
  };
  createAsyncQuestionPresentation(current, answeredProps);
  pendingWrite.resolve({ status: "persisted" });
  await reopening;
  expect(onReopen).not.toHaveBeenCalled();
  expect(createAsyncQuestionPresentation(current, answeredProps).pending).toHaveLength(0);
});

it("does not expand a replacement owner after a delayed restoration save", async () => {
  storage.read.mockResolvedValueOnce({
    status: "found",
    draft: { revision: 10, writeId: "dismissed", questionDrafts: [{ ...saved, dismissed: true }] },
  });
  const onReopen = vi.fn();
  const activeProps = { ...props, onReopen };
  const current = state();
  createAsyncQuestionPresentation(current, activeProps);
  await settled(current);
  const pendingWrite = createDeferred<unknown>();
  storage.write.mockReturnValue(pendingWrite.promise);
  const reopening = createAsyncQuestionPresentation(current, activeProps).reopen(question.itemId);
  await vi.waitFor(() => expect(storage.write).toHaveBeenCalledOnce());
  createAsyncQuestionPresentation(current, {
    ...activeProps,
    asyncQuestionStorage: { ...owner, recoveryScope: "person-b" },
  });
  pendingWrite.resolve({ status: "persisted" });
  await reopening;
  expect(onReopen).not.toHaveBeenCalled();
  expect(current.asyncQuestionDrafts.get(question.itemId)?.answers.get("0")?.freeText).toBe("");
});

it("saves the latest completion boundary before completing a delayed Undo", async () => {
  const onReopen = vi.fn();
  const initialProps = {
    ...props,
    onReopen,
    messages: [{ ...props.messages[0], runId: "original-run" }],
  };
  const current = state();
  await createAsyncQuestionPresentation(current, initialProps).dismiss(question.itemId);
  const firstWrite = createDeferred<unknown>();
  const latestWrite = createDeferred<unknown>();
  storage.write
    .mockClear()
    .mockReturnValueOnce(firstWrite.promise)
    .mockReturnValueOnce(latestWrite.promise);
  const reopening = createAsyncQuestionPresentation(current, initialProps).reopen(question.itemId);
  await vi.waitFor(() => expect(storage.write).toHaveBeenCalledTimes(1));
  const latestProps = {
    ...initialProps,
    messages: [
      ...initialProps.messages,
      ...["original-run", "successor-run"].map((runId, index) => ({
        role: "assistant",
        runId,
        phase: "final_answer",
        stopReason: "stop",
        content: "Finished the requested work.",
        __openclaw: { id: `final-${runId}`, seq: index + 2, runTerminal: true },
      })),
    ],
  };
  createAsyncQuestionPresentation(current, latestProps);
  firstWrite.resolve({ status: "persisted" });
  await vi.waitFor(() => expect(storage.write).toHaveBeenCalledTimes(2));
  expect(onReopen).not.toHaveBeenCalled();
  expect(createAsyncQuestionPresentation(current, latestProps).pending).toHaveLength(0);
  const latestStored = storage.write.mock.calls[1]![1];
  expect(latestStored.questionDrafts[0].reopenedAfterBoundary).toBeTruthy();
  latestWrite.resolve({ status: "persisted" });
  await reopening;
  expect(onReopen).toHaveBeenCalledOnce();
  storage.read.mockResolvedValue({
    status: "found",
    draft: { ...latestStored, writeId: "latest" },
  });
  const reloaded = state();
  createAsyncQuestionPresentation(reloaded, latestProps);
  await settled(reloaded);
  expect(createAsyncQuestionPresentation(reloaded, latestProps).pending).toHaveLength(1);
});

it("keeps answering available with an unsaved warning when restoring a dismissal cannot persist", async () => {
  storage.read.mockResolvedValue({
    status: "found",
    draft: { revision: 10, writeId: "dismissed", questionDrafts: [{ ...saved, dismissed: true }] },
  });
  const current = state();
  createAsyncQuestionPresentation(current, props);
  await settled(current);
  storage.write.mockResolvedValue({ status: "storage-failed" });
  await createAsyncQuestionPresentation(current, props).reopen(question.itemId);
  const reopened = createAsyncQuestionPresentation(current, props);
  expect(reopened.pending).toHaveLength(1);
  expect(reopened.storageError).toContain("not saved");
  expect(reopened.drafts.get(question.itemId)?.answers.get("0")?.freeText).toBe("Saved answer");
});

it.each(["mounted", "reloaded"] as const)(
  "preserves ambiguous free-text answers when a failed queued answer is discarded (%s)",
  async (mount) => {
    const multiQuestion = {
      itemId: "free-text",
      questions: [{ title: "Audience?" }, { title: "Format?" }],
    };
    const answers = ["Include this example:\n\n> Format?\n\nKeep quoted text", "Detailed"];
    let stored: unknown;
    storage.read.mockImplementation(async () =>
      stored ? { status: "found", draft: stored } : { status: "not-found" },
    );
    storage.write.mockImplementation(async (_scope, draft, options) => {
      stored = { ...draft, writeId: options.writeId };
      return { status: "persisted" };
    });
    const current = state();
    const submit = vi.fn(async (_message: string) => true);
    current.transcriptRenderContext.onAsyncQuestionSubmit = submit;
    const activeProps = {
      ...props,
      onAsyncQuestionSubmit: submit,
      messages: [{ role: "assistant", openclawAsyncDelivery: multiQuestion }],
    };
    const initial = createAsyncQuestionPresentation(current, activeProps);
    const panel = createAsyncQuestionPanelProps(multiQuestion, initial, {});
    for (const [index, freeText] of answers.entries()) {
      panel.model.drafts.set(String(index), { selected: new Set(), freeText });
    }
    panel.onChange?.();
    await panel.onSubmit?.({ "0": [answers[0]!], "1": [answers[1]!] });
    await settled(current);
    const queued = {
      id: "failed-free-text",
      asyncQuestionItemId: multiQuestion.itemId,
      text: submit.mock.calls[0]![0],
      createdAt: 1,
      sendState: "failed" as const,
    };
    const recoveredState = mount === "reloaded" ? state() : current;
    const deliveryProps = { ...activeProps, queue: [queued] };
    createAsyncQuestionPresentation(recoveredState, deliveryProps);
    await settled(recoveredState);
    const delivered = createAsyncQuestionPresentation(recoveredState, deliveryProps);
    expect(delivered.pending).toEqual([]);
    const summary = document.createElement("div");
    render(renderAsyncQuestionSummary(multiQuestion, delivered), summary);
    expect(summary.textContent).toContain(queued.text);
    const revisedText = queued.text.replace("Include this example:", "Updated in the outbox:");
    render(
      renderAsyncQuestionSummary(
        multiQuestion,
        createAsyncQuestionPresentation(recoveredState, {
          ...deliveryProps,
          queue: [{ ...queued, text: revisedText }],
        }),
      ),
      summary,
    );
    expect(summary.textContent).toContain(revisedText);
    expect(summary.textContent).not.toContain("Include this example:");
    render(null, summary);
    delivered.discard(queued);
    const reopened = createAsyncQuestionPresentation(recoveredState, activeProps);
    expect(reopened.pending.map((entry) => entry.itemId)).toEqual([multiQuestion.itemId]);
    expect(
      [...createAsyncQuestionPanelProps(multiQuestion, reopened, {}).model.drafts.values()].map(
        (answer) => answer.freeText,
      ),
    ).toEqual(answers);
    await settled(recoveredState);
  },
);
