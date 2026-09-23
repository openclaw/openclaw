// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as draftStore from "../../lib/chat/composer-draft-store.runtime.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ChatComposerPersistence, persistChatComposerState } from "./composer-persistence.ts";
import * as durableComposer from "./durable-composer-persistence.ts";

function createState() {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    sessionKey: "agent:main:restore",
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    client: { recoveryScope: "test-owner", recoveryScopeReady: true },
    connected: true,
    selectedChatSessionIncognito: false,
  };
}

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
  vi.spyOn(draftStore, "writeDurableComposerDraft").mockResolvedValue({ status: "persisted" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("captures once per restore admission while pending, settled, reset, and switching scope", async () => {
  const pending = createDeferred<Awaited<ReturnType<typeof draftStore.readDurableComposerDraft>>>();
  const read = vi.spyOn(draftStore, "readDurableComposerDraft").mockReturnValue(pending.promise);
  const capture = vi.spyOn(durableComposer, "captureDurableChatAttachments");
  const state = createState();
  state.chatMessage = "Saved draft";
  expect(persistChatComposerState(state, state.sessionKey, { draftRevision: 1 })).toBe(true);
  let owner: typeof state | undefined = state;
  const persistence = new ChatComposerPersistence(() => owner);
  try {
    persistence.start();
    expect(capture).toHaveBeenCalled();
    capture.mockClear();
    for (let index = 0; index < 3; index++) {
      persistence.persistChangedState();
    }
    expect(capture).not.toHaveBeenCalled();
    await settleStorage();
    expect(read).toHaveBeenCalledOnce();

    pending.resolve({ status: "not-found", revision: 0 });
    await settleStorage();
    expect(draftStore.writeDurableComposerDraft).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryScope: "test-owner" }),
      expect.objectContaining({ revision: 1, text: "Saved draft", attachments: [] }),
      expect.objectContaining({ expectedRevision: 0 }),
    );
    capture.mockClear();
    for (let index = 0; index < 3; index++) {
      persistence.persistChangedState();
    }
    expect(capture).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();

    persistence.restore();
    capture.mockClear();
    persistence.persistChangedState();
    expect(capture).toHaveBeenCalledOnce();
    capture.mockClear();
    persistence.persistChangedState();
    expect(capture).not.toHaveBeenCalled();
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
    capture.mockClear();
    persistence.persistChangedState();
    expect(capture).not.toHaveBeenCalled();
  } finally {
    owner = undefined;
    persistence.stop();
    pending.resolve({ status: "not-found", revision: 0 });
    await settleStorage();
  }
});

it("keeps a synchronous new edit when an older stored draft has a higher revision", async () => {
  // Scheduling must stay below the stored revision even if the test process pauses.
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const pending = createDeferred<Awaited<ReturnType<typeof draftStore.readDurableComposerDraft>>>();
  const read = vi.spyOn(draftStore, "readDurableComposerDraft").mockReturnValue(pending.promise);
  const storedRevision = nextDraftRevision() + 100;
  const state = createState();
  let owner: typeof state | undefined = state;
  const persistence = new ChatComposerPersistence(() => owner);
  try {
    persistence.start();
    state.chatMessage = "New edit during restore";
    persistence.schedule();
    await settleStorage();
    expect(read).toHaveBeenCalledOnce();
    pending.resolve({
      status: "found",
      draft: {
        revision: storedRevision,
        text: "Older saved draft",
        attachments: [],
        writeId: "stored-draft",
      },
    });
    await settleStorage();
    expect(state.chatMessage).toBe("New edit during restore");
  } finally {
    owner = undefined;
    persistence.stop();
    pending.resolve({ status: "not-found", revision: 0 });
    await settleStorage();
  }
});
