/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, nextEventLoopTurn } from "../../../../test/helpers/promise.ts";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import type {
  ChatSelectionAnnotation,
  DurableComposerDraftScope,
} from "../../lib/chat/chat-types.ts";
import { ChatSessionCompanionThreads } from "./chat-session-companion.ts";

const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("../../lib/chat/composer-draft-store.runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/chat/composer-draft-store.runtime.ts")>()),
  readDurableComposerDraft: storage.read,
  writeDurableComposerDraft: storage.write,
}));
const scope = {
  gatewayOwner: "ws://fixture",
  recoveryScope: "person-a",
  scopeKey: "comments:v1:chat:v3:agent:main:one",
};
const annotation: ChatSelectionAnnotation = {
  sessionKey: "agent:main:one",
  messageId: "message-one",
  entryId: "entry-one",
  start: 4,
  end: 12,
  text: "the text",
  comment: "the comment",
};
const attachment = (comment = annotation.comment) => ({
  id: "context-only",
  mimeType: "text/plain",
  selectionAnnotation: { ...annotation, comment },
});
const found = () => ({
  status: "found",
  draft: {
    revision: 10,
    writeId: "saved",
    text: "",
    attachments: [],
    selectionAnnotations: [annotation],
  },
});
const settle = async () => {
  await nextEventLoopTurn();
  expect(storage.write).toHaveBeenCalled();
};
beforeEach(async () => {
  storage.read.mockReset().mockResolvedValue({ status: "not-found" });
  storage.write.mockReset().mockResolvedValue({ status: "persisted" });
  // Preload the mocked owner so one event-loop turn drains only queued Promise
  // work, rather than racing asynchronous module I/O or polling a wall clock.
  await import("../../lib/chat/composer-draft-store.runtime.ts");
});
const owners = new Set<ChatSessionCompanionThreads>();
afterEach(() => {
  for (const threads of owners) {
    threads.retire();
  }
  owners.clear();
});
function owner(resolve: () => DurableComposerDraftScope | null = () => scope) {
  const error = vi.fn();
  const threads = new ChatSessionCompanionThreads({ scope: resolve, onError: error });
  owners.add(threads);
  return { threads, error, view: () => threads.view(annotation.sessionKey, "main") };
}

it("stores comment-only drafts without requiring a Blob and restores exact anchors on a new owner", async () => {
  const original = owner();
  original.threads.setAttachments(annotation.sessionKey, [attachment()], "main");
  await settle();
  expect(storage.write).toHaveBeenCalledWith(
    scope,
    expect.objectContaining({ text: "", attachments: [], selectionAnnotations: [annotation] }),
    expect.objectContaining({ expectedRevision: 0 }),
  );
  storage.read.mockResolvedValue(found());
  const recovered = owner();
  recovered.view();
  await nextEventLoopTurn();
  expect(recovered.view().attachments).toEqual([
    expect.objectContaining({ selectionAnnotation: annotation }),
  ]);
  expect(recovered.view().attachments?.[0]?.dataUrl).toBeUndefined();
});

it("preserves an edit made while storage opens and saves removal as an empty draft", async () => {
  const pending = createDeferred<ReturnType<typeof found>>();
  storage.read.mockReturnValue(pending.promise);
  const current = owner();
  current.view();
  current.threads.setAttachments(annotation.sessionKey, [attachment("new comment")], "main");
  pending.resolve(found());
  await settle();
  expect(current.view().attachments?.[0]?.selectionAnnotation?.comment).toBe("new comment");
  expect(storage.write.mock.calls[0]?.[1].selectionAnnotations).toEqual([
    { ...annotation, comment: "new comment" },
  ]);
  current.threads.setAttachments(annotation.sessionKey, [], "main");
  await nextEventLoopTurn();
  expect(storage.write).toHaveBeenCalledTimes(2);
  expect(storage.write.mock.calls[1]?.[1].selectionAnnotations).toEqual([]);
});

it.each(["gatewayOwner", "recoveryScope", "scopeKey"] as const)(
  "does not restore or write an old %s into its replacement",
  async (field) => {
    const pending = createDeferred<ReturnType<typeof found>>();
    storage.read.mockReturnValueOnce(pending.promise).mockResolvedValue({ status: "not-found" });
    let active = scope;
    const current = owner(() => active);
    current.view();
    await nextEventLoopTurn();
    expect(storage.read).toHaveBeenCalledTimes(1);
    current.threads.setAttachments(annotation.sessionKey, [attachment()], "main");
    active = { ...scope, [field]: "replacement" };
    current.view();
    pending.resolve(found());
    await nextEventLoopTurn();
    expect(storage.read).toHaveBeenCalledTimes(2);
    expect(current.view().attachments).toEqual([]);
    expect(storage.write).not.toHaveBeenCalled();
  },
);

it("keeps Incognito comments memory-only and reports a rejected durable write without clearing local text", async () => {
  const privateOwner = owner(() => null);
  privateOwner.threads.setAttachments(annotation.sessionKey, [attachment()], "main");
  expect(privateOwner.view().attachments).toHaveLength(1);
  expect(storage.read).not.toHaveBeenCalled();
  expect(storage.write).not.toHaveBeenCalled();
  storage.write.mockResolvedValue({ status: "conflict" });
  const current = owner();
  current.threads.setAttachments(annotation.sessionKey, [attachment()], "main");
  await settle();
  await nextEventLoopTurn();
  expect(current.error).toHaveBeenCalledTimes(1);
  expect(current.view().attachments?.[0]?.selectionAnnotation).toEqual(annotation);
});

it("retires stored comments when a side-chat turn consumes them or Clear succeeds", async () => {
  const current = owner();
  current.threads.setAttachments(annotation.sessionKey, [attachment()], "main");
  await settle();
  await current.threads.submit(
    annotation.sessionKey,
    "Use my comments",
    async () => ({ answer: "done", ts: 1 }),
    "main",
  );
  await nextEventLoopTurn();
  expect(storage.write).toHaveBeenCalledTimes(2);
  expect(storage.write.mock.calls[1]?.[1].selectionAnnotations).toEqual([]);
  current.threads.setAttachments(annotation.sessionKey, [attachment()], "main");
  await nextEventLoopTurn();
  expect(storage.write).toHaveBeenCalledTimes(3);
  await current.threads.reset(annotation.sessionKey, async () => ({ ok: true }), "main");
  await nextEventLoopTurn();
  expect(storage.write).toHaveBeenCalledTimes(4);
  expect(storage.write.mock.calls[3]?.[1].selectionAnnotations).toEqual([]);
});

it("fences pre-retirement edits but accepts a later explicit comment", async () => {
  const pending = createDeferred<{ status: "not-found"; revision: number; writeId: string }>();
  storage.read.mockReturnValue(pending.promise);
  const current = owner();
  current.view();
  await nextEventLoopTurn();
  expect(storage.read).toHaveBeenCalledTimes(1);
  current.threads.setAttachments(annotation.sessionKey, [attachment("retired edit")], "main");
  const revision = Date.now() + 1000;
  pending.resolve({ status: "not-found", revision, writeId: "retired" });
  await nextEventLoopTurn();
  expect(current.view().attachments).toEqual([]);
  expect(storage.write).not.toHaveBeenCalled();
  current.threads.setAttachments(annotation.sessionKey, [attachment("new explicit edit")], "main");
  await settle();
  expect(storage.write).toHaveBeenCalledTimes(1);
  expect(storage.write.mock.calls[0]?.[1].selectionAnnotations).toEqual([
    { ...annotation, comment: "new explicit edit" },
  ]);
  expect(storage.write.mock.calls[0]?.[2].expectedRevision).toBe(revision);
});

it("waits for saved comments before sending and retires them only after capturing the complete turn", async () => {
  const pending = createDeferred<ReturnType<typeof found>>();
  storage.read.mockReturnValue(pending.promise);
  const current = owner();
  current.view();
  await nextEventLoopTurn();
  expect(storage.read).toHaveBeenCalledTimes(1);
  const ask = vi.fn(async () => ({ answer: "done", ts: 1 }));
  const submitted = current.threads.submit(
    annotation.sessionKey,
    "Use my saved comment",
    ask,
    "main",
  );
  expect(ask).not.toHaveBeenCalled();
  expect(storage.write).not.toHaveBeenCalled();
  pending.resolve(found());
  await submitted;
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ask).toHaveBeenCalledWith(annotation.sessionKey, "Use my saved comment", [
    expect.objectContaining({ selectionAnnotation: annotation }),
  ]);
  await settle();
  expect(storage.write.mock.calls[0]?.[1].selectionAnnotations).toEqual([]);
  expect(current.view().attachments).toEqual([]);
});

it.each(["draft", "attachments", "account"] as const)(
  "does not send an old question after %s changes while restoration is pending",
  async (change) => {
    const pending = createDeferred<ReturnType<typeof found>>();
    storage.read.mockReturnValue(pending.promise);
    let active = scope;
    const current = owner(() => active);
    current.view();
    await nextEventLoopTurn();
    expect(storage.read).toHaveBeenCalledTimes(1);
    const ask = vi.fn(async () => ({ answer: "done", ts: 1 }));
    const submitted = current.threads.submit(annotation.sessionKey, "Old question", ask, "main");
    if (change === "draft") {
      current.threads.setDraft(annotation.sessionKey, "New question", "main");
    }
    if (change === "attachments") {
      current.threads.setAttachments(annotation.sessionKey, [attachment("New comment")], "main");
    }
    if (change === "account") {
      active = { ...scope, recoveryScope: "replacement" };
    }
    pending.resolve(found());
    await submitted;
    expect(ask).not.toHaveBeenCalled();
    if (change === "draft") {
      expect(current.view().draft).toBe("New question");
    }
    if (change === "attachments") {
      expect(current.view().attachments?.[0]?.selectionAnnotation?.comment).toBe("New comment");
    }
  },
);

it.each([false, true])(
  "Clear retires comments restored during its request and preserves newer comment=%s",
  async (newComment) => {
    const pending = createDeferred<ReturnType<typeof found>>();
    const cleared = createDeferred<{ ok: true }>();
    storage.read.mockReturnValue(pending.promise);
    const current = owner();
    current.view();
    await nextEventLoopTurn();
    expect(storage.read).toHaveBeenCalledTimes(1);
    const resetting = current.threads.reset(annotation.sessionKey, () => cleared.promise, "main");
    pending.resolve(found());
    await nextEventLoopTurn();
    expect(current.view().attachments).toHaveLength(1);
    if (newComment) {
      current.threads.setAttachments(
        annotation.sessionKey,
        [
          ...(current.view().attachments ?? []),
          { ...attachment("New comment"), id: "new-comment" },
        ],
        "main",
      );
    }
    cleared.resolve({ ok: true });
    await resetting;
    const expected = newComment ? [{ ...annotation, comment: "New comment" }] : [];
    expect(current.view().attachments?.map((item) => item.selectionAnnotation)).toEqual(expected);
    await nextEventLoopTurn();
    expect(storage.write.mock.calls.at(-1)?.[1].selectionAnnotations).toEqual(expected);
  },
);

it.each([false, true])(
  "keeps plain-text Side chat usable after reported read failure, rejected=%s",
  async (rejected) => {
    if (rejected) {
      storage.read.mockRejectedValue(new Error("IndexedDB unavailable"));
    } else {
      storage.read.mockResolvedValue({ status: "storage-failed" });
    }
    const current = owner();
    current.view();
    current.threads.setDraft(annotation.sessionKey, "My memory-only question", "main");
    await nextEventLoopTurn();
    expect(current.error).toHaveBeenCalledTimes(1);
    const ask = vi.fn(async () => ({ answer: "done", ts: 1 }));
    await current.threads.submit(annotation.sessionKey, "My memory-only question", ask, "main");
    expect(ask).toHaveBeenCalledWith(annotation.sessionKey, "My memory-only question", undefined);
    expect(current.view()).toMatchObject({
      draft: "",
      turns: [{ status: "answered", answer: "done" }],
    });
    expect(storage.write).not.toHaveBeenCalled();
    expect(current.error).toHaveBeenCalledTimes(1);
  },
);

it("clears memory-only Side chat after a reported storage read failure", async () => {
  storage.read.mockResolvedValue({ status: "storage-failed" });
  const current = owner();
  await current.threads.hydrate(
    annotation.sessionKey,
    async () => ({ exchanges: [{ question: "earlier", answer: "earlier answer", ts: 1 }] }),
    "main",
  );
  current.threads.setDraft(annotation.sessionKey, "Local draft", "main");
  current.threads.setAttachments(annotation.sessionKey, [attachment()], "main");
  await nextEventLoopTurn();
  expect(current.error).toHaveBeenCalledTimes(1);
  const clear = vi.fn(async () => ({ ok: true as const }));
  await current.threads.reset(annotation.sessionKey, clear, "main");
  expect(clear).toHaveBeenCalledOnce();
  expect(current.view()).toMatchObject({ draft: "", attachments: [], turns: [] });
  expect(storage.write).not.toHaveBeenCalled();
});

it("still cancels a stale account's submission after falling back to memory-only input", async () => {
  storage.read.mockResolvedValue({ status: "storage-failed" });
  let active = scope;
  const current = owner(() => active);
  const previous = current.view();
  current.threads.setDraft(annotation.sessionKey, "Keep my local input", "main");
  await nextEventLoopTurn();
  expect(current.error).toHaveBeenCalledTimes(1);
  const ask = vi.fn(async () => ({ answer: "done", ts: 1 }));
  const submitted = current.threads.submit(
    annotation.sessionKey,
    "Keep my local input",
    ask,
    "main",
  );
  active = { ...scope, recoveryScope: "replacement" };
  await submitted;
  expect(ask).not.toHaveBeenCalled();
  expect(previous.draft).toBe("Keep my local input");
  expect(storage.write).not.toHaveBeenCalled();
});

it.each(["persisted", "storage-failed"] as const)(
  "protects edited comments until the durable save settles as %s",
  async (status) => {
    const write = createDeferred<{ status: "persisted" | "storage-failed" }>();
    storage.write.mockReturnValue(write.promise);
    const current = owner();
    current.threads.setAttachments(annotation.sessionKey, [attachment("new edit")], "main");
    expect(canReloadControlUiDocument()).toBe(false);
    const unloading = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloading);
    expect(unloading.defaultPrevented).toBe(true);
    await nextEventLoopTurn();
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(current.view().commentsSaving).toBe(true);
    write.resolve({ status });
    await nextEventLoopTurn();
    expect(canReloadControlUiDocument()).toBe(true);
    expect(current.view().commentsSaving).toBe(false);
    const settledUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(settledUnload);
    expect(settledUnload.defaultPrevented).toBe(false);
    expect(current.error).toHaveBeenCalledTimes(status === "persisted" ? 0 : 1);
  },
);

it("keeps reload protection across queued edits until the newest save settles", async () => {
  const first = createDeferred<{ status: "persisted" }>();
  const second = createDeferred<{ status: "persisted" }>();
  storage.write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const current = owner();
  current.threads.setAttachments(annotation.sessionKey, [attachment()], "main");
  await nextEventLoopTurn();
  current.threads.setAttachments(annotation.sessionKey, [attachment("newest edit")], "main");
  first.resolve({ status: "persisted" });
  await nextEventLoopTurn();
  expect(storage.write).toHaveBeenCalledTimes(2);
  expect(canReloadControlUiDocument()).toBe(false);
  second.resolve({ status: "persisted" });
  await nextEventLoopTurn();
  expect(canReloadControlUiDocument()).toBe(true);
});
