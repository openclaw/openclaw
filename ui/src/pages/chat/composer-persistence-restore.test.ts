// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatGoalDraftMode } from "../../lib/chat/chat-types.ts";
import * as draftStore from "../../lib/chat/composer-draft-store.runtime.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";
import {
  storageTargetForComposer,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  ChatComposerPersistence,
  loadChatComposerState as load,
  restoreChatComposerState as restore,
  persistChatComposerState as persist,
} from "./composer-persistence.ts";
import * as durableComposer from "./durable-composer-persistence.ts";

type ReadResult = Awaited<ReturnType<typeof draftStore.readDurableComposerDraft>>;
type FoundDraft = Extract<ReadResult, { status: "found" }>["draft"];
let write = draftStore.writeDurableComposerDraft;
const retireDraft = () =>
  vi.spyOn(draftStore, "retireDurableComposerDraft").mockResolvedValue({ status: "persisted" });
const draftRead = () => vi.spyOn(draftStore, "readDurableComposerDraft");
const missing: ReadResult = { status: "not-found", revision: 0 };
const foundDraft = (text: string, fields: Partial<FoundDraft> = {}): ReadResult => ({
  status: "found",
  draft: { revision: 1, text, attachments: [], writeId: "stored", ...fields },
});
type State = NonNullable<ReturnType<ConstructorParameters<typeof ChatComposerPersistence>[0]>>;
const cleanups: (() => void)[] = [];
function persistenceFor(state: State, keepOwner = false, release = () => {}) {
  let owner: State | undefined = state;
  const persistence = new ChatComposerPersistence(() => owner);
  cleanups.push(() => {
    owner = keepOwner ? owner : undefined;
    persistence.stop();
    release();
  });
  persistence.start();
  return persistence;
}
function pendingRestore(state: State) {
  const pending = createDeferred<ReadResult>();
  const read = draftRead().mockReturnValue(pending.promise);
  const persistence = persistenceFor(state, false, () => pending.resolve(missing));
  return { pending, read, persistence };
}
function expectWrite(
  scope: unknown,
  draft: Record<string, unknown>,
  options: unknown = expect.anything(),
) {
  expect(write).toHaveBeenCalledWith(scope, expect.objectContaining(draft), options);
}
const ownerScope = expect.objectContaining({ recoveryScope: "test-owner" });
const createState = (overrides: Partial<State> = {}): State => ({
  settings: { gatewayUrl: "ws://gateway.test/control" },
  sessionKey: "agent:main:restore",
  chatMessage: "",
  chatAttachments: [],
  chatQueue: [],
  chatGoalDraftMode: null,
  chatReplyTarget: null,
  client: { recoveryScope: "test-owner", recoveryScopeReady: true },
  connected: true,
  selectedChatSessionIncognito: false,
  ...overrides,
});

// Storage uses controlled promises; drain their restore/write continuations before assertions.
const settleStorage = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.spyOn(draftStore, "prepareDurableComposerRecovery").mockResolvedValue({
    status: "ready",
    entries: [],
  });
  write = vi
    .spyOn(draftStore, "writeDurableComposerDraft")
    .mockResolvedValue({ status: "persisted" });
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
    await settleStorage();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it.each([
  { boundary: "gateway", privateSource: false },
  { boundary: "credential", privateSource: false },
  { boundary: "gateway", privateSource: true },
  { boundary: "credential", privateSource: true },
])("captures $boundary ownership (private=$privateSource)", async ({ boundary, privateSource }) => {
  draftRead().mockResolvedValue(missing);
  const retire = retireDraft();
  const state = createState({
    selectedChatSessionIncognito: privateSource,
    chatMessage: "initial",
  });
  const persistence = persistenceFor(state);
  await settleStorage();
  const sourceScope = persistence.durableScope;
  state.chatMessage = "captured";
  persistence.schedule();
  if (boundary === "gateway") {
    state.settings = { gatewayUrl: "ws://destination.test/control" };
  } else {
    state.client = { recoveryScope: "destination-owner", recoveryScopeReady: true };
  }
  state.selectedChatSessionIncognito = !privateSource;
  state.chatMessage = "destination";
  if (privateSource) {
    expect(persist(state)).toBe(true);
  }
  const destinationKey = storageTargetForComposer(state).key;
  const destinationMetadata = sessionStorage.getItem(destinationKey);
  vi.mocked(write).mockClear();
  retire.mockClear();
  persistence.persistNow();
  await settleStorage();
  expect(retire).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(destinationKey)).toBe(destinationMetadata);
  if (privateSource) {
    expect(write).not.toHaveBeenCalled();
    expect(load(state, state.sessionKey).snapshot?.draft).toBe("destination");
  } else {
    expectWrite(sourceScope, { text: "captured" });
  }
  expect(state.chatMessage).toBe("destination");
});

it("retires the durable draft when a write notification reveals Incognito metadata", async () => {
  draftRead().mockResolvedValue(foundDraft("previous"));
  const retire = retireDraft();
  const state = createState();
  const persistence = persistenceFor(state, true);
  await settleStorage();
  const capturedScope = persistence.durableScope;
  expect(capturedScope).not.toBeNull();
  vi.mocked(write).mockClear();
  const unsubscribe = subscribeStoredChatOutboxChanges(() => {
    state.selectedChatSessionIncognito = true;
    persistence.persistChangedState();
  });
  cleanups.push(unsubscribe);
  state.chatMessage = "";
  persistence.schedule();
  persistence.persistNow();
  await settleStorage();
  expect(state).toMatchObject({ selectedChatSessionIncognito: true, chatMessage: "" });
  expect(retire).toHaveBeenCalledWith(capturedScope, expect.any(Number));
  expect(write).not.toHaveBeenCalled();
});

it("retires private tab input when a pending snapshot predates the authenticated owner", async () => {
  const retire = retireDraft();
  const client = { recoveryScope: "", recoveryScopeReady: false };
  const state = createState({ connected: false, client, chatMessage: "old private" });
  expect(persist(state)).toBe(false);
  const persistence = persistenceFor(state);
  state.chatMessage = "current private";
  persistence.schedule();
  state.connected = true;
  Object.assign(client, { recoveryScope: "authenticated-owner", recoveryScopeReady: true });
  state.selectedChatSessionIncognito = true;
  persistence.persistChangedState();
  await settleStorage();
  const stored = sessionStorage.getItem(storageTargetForComposer(state).key);
  expect(stored ?? "").not.toContain("old private");
  expect(stored ?? "").not.toContain("current private");
  expect(state.chatMessage).toBe("current private");
  expect(retire).toHaveBeenCalledWith(
    expect.objectContaining({ recoveryScope: "authenticated-owner" }),
    expect.any(Number),
  );
});

it.each([false, true])(
  "restores metadata without replacing pre-auth edits (%s)",
  async (edited) => {
    const goalMode: ChatGoalDraftMode = { action: "start", sessionId: "saved-session" };
    draftRead().mockResolvedValue(foundDraft("saved", { goalMode }));
    const client = {
      recoveryScope: "",
      recoveryScopeReady: false,
      offlineRecoveryScope: "test-owner",
    };
    const state = createState({ connected: false, client, chatMessage: "saved" });
    expect(persist(state, state.sessionKey, { draftRevision: 1 })).toBe(true);
    const persistence = persistenceFor(state);
    if (edited) {
      state.chatMessage = "pre-auth edit";
      persistence.schedule();
    }
    state.connected = true;
    Object.assign(client, { recoveryScope: "test-owner", recoveryScopeReady: true });
    persistence.persistChangedState();
    await settleStorage();
    expect(state).toMatchObject({
      chatMessage: edited ? "pre-auth edit" : "saved",
      chatGoalDraftMode: edited ? null : goalMode,
    });
    if (edited) {
      expectWrite(ownerScope, { text: "pre-auth edit" });
    } else {
      expect(write).not.toHaveBeenCalled();
    }
  },
);

it("captures once per restore admission while pending, settled, reset, and switching scope", async () => {
  const capture = vi.spyOn(durableComposer, "captureDurableChatAttachments");
  const state = createState({ chatMessage: "Saved draft" });
  expect(persist(state, state.sessionKey, { draftRevision: 1 })).toBe(true);
  const { pending, read, persistence } = pendingRestore(state);
  const expectUncaptured = (repeat = 1) => {
    capture.mockClear();
    for (let index = 0; index < repeat; index++) {
      persistence.persistChangedState();
    }
    expect(capture).not.toHaveBeenCalled();
  };
  expect(capture).toHaveBeenCalled();
  expectUncaptured(3);
  await settleStorage();
  expect(read).toHaveBeenCalledOnce();

  pending.resolve(missing);
  await settleStorage();
  expectWrite(
    ownerScope,
    { revision: 1, text: "Saved draft", attachments: [] },
    expect.objectContaining({ expectedRevision: 0 }),
  );
  expectUncaptured(3);
  expect(read).toHaveBeenCalledOnce();

  persistence.restore();
  capture.mockClear();
  persistence.persistChangedState();
  expect(capture).toHaveBeenCalledOnce();
  expectUncaptured();
  await settleStorage();
  expect(read).toHaveBeenCalledTimes(2);

  state.sessionKey = "agent:main:other";
  persistence.persistChangedState();
  await settleStorage();
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({ scopeKey: expect.stringContaining("agent:main:other") }),
  );
  expectUncaptured();
});

it("keeps a synchronous reply cancellation when an older stored draft has a higher revision", async () => {
  // Scheduling must stay below the stored revision even if the test process pauses.
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const storedRevision = nextDraftRevision() + 100;
  const previousReply = { messageId: "previous", text: "Previous selection" };
  const state = createState({ chatReplyTarget: previousReply });
  expect(persist(state, state.sessionKey, { draftRevision: 1 })).toBe(true);
  const { pending, read, persistence } = pendingRestore(state);
  state.chatReplyTarget = null;
  persistence.schedule();
  await settleStorage();
  expect(read).toHaveBeenCalledOnce();
  pending.resolve(
    foundDraft("Older saved draft", {
      revision: storedRevision,
      replyTarget: previousReply,
    }),
  );
  await settleStorage();
  expect(state).toMatchObject({ chatMessage: "", chatReplyTarget: null });
});

it("persists empty goal selection and versions cancellation", () => {
  const state = createState({ client: null, connected: false });
  const persistence = new ChatComposerPersistence(() => state);
  persistence.start();
  state.chatGoalDraftMode = { action: "start", sessionId: "session-a" };
  persistence.schedule();
  persistence.persistNow();
  const revision = load(state, state.sessionKey).revisions.latestAttempt;
  const restored = createState({ client: null, connected: false });
  expect(restore(restored)).toBe(true);
  expect(restored).toMatchObject({
    chatGoalDraftMode: state.chatGoalDraftMode,
    chatReplyTarget: state.chatReplyTarget,
  });
  state.chatGoalDraftMode = null;
  state.chatReplyTarget = null;
  persistence.schedule();
  persistence.persistNow();
  expect(load(state, state.sessionKey).revisions.latestAttempt).toBeGreaterThan(revision);
  expect(load(state, state.sessionKey).snapshot).toBeNull();
  persistence.stop();
});
