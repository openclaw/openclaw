/* @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { DurableQuestionDraft } from "../../../lib/chat/composer-draft-store.runtime.ts";
import {
  createAsyncQuestionPanelProps,
  createAsyncQuestionPresentation,
} from "./chat-async-question.ts";
import { getTranscriptState, resetThreadPresentation } from "./chat-thread-interactions.ts";

const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
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

it("retires a skipped answer instead of recovering it as a protected draft after reload", async () => {
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

  expect(stored.questionDrafts).toEqual([]);
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
  expect(recovered.drafts.get(question.itemId)?.edited).not.toBe(true);
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
