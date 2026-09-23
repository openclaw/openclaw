// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as draftStore from "../../lib/chat/composer-draft-store.runtime.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";
import {
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  ChatComposerPersistence,
  loadChatComposerSnapshot,
  persistChatComposerState,
} from "./composer-persistence.ts";
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

it.each([
  { boundary: "gateway", privateSource: false },
  { boundary: "credential", privateSource: false },
  { boundary: "gateway", privateSource: true },
  { boundary: "credential", privateSource: true },
])(
  "keeps a captured draft with its $boundary owner (private=$privateSource)",
  async ({ boundary, privateSource }) => {
    vi.spyOn(draftStore, "readDurableComposerDraft").mockResolvedValue({
      status: "not-found",
      revision: 0,
    });
    const retire = vi.spyOn(draftStore, "retireDurableComposerDraft").mockResolvedValue({
      status: "persisted",
    });
    const state = createState();
    state.selectedChatSessionIncognito = privateSource;
    state.chatMessage = "Source initial input";
    let owner: typeof state | undefined = state;
    const persistence = new ChatComposerPersistence(() => owner);
    persistence.start();
    await settleStorage();
    const sourceScope = persistence.durableScope;
    state.chatMessage = "Captured source input";
    persistence.schedule();
    if (boundary === "gateway") {
      state.settings = { gatewayUrl: "ws://destination.test/control" };
    } else {
      state.client = { recoveryScope: "destination-owner", recoveryScopeReady: true };
    }
    state.selectedChatSessionIncognito = !privateSource;
    state.chatMessage = "Destination input";
    if (privateSource) {
      expect(persistChatComposerState(state)).toBe(true);
    }
    const destinationKey = storageTargetForGateway(state.settings.gatewayUrl).key;
    const destinationMetadata = sessionStorage.getItem(destinationKey);
    vi.mocked(draftStore.writeDurableComposerDraft).mockClear();
    retire.mockClear();
    try {
      persistence.persistNow();
      await settleStorage();
      expect(retire).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(destinationKey)).toBe(destinationMetadata);
      if (privateSource) {
        expect(draftStore.writeDurableComposerDraft).not.toHaveBeenCalled();
        expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("Destination input");
      } else {
        expect(draftStore.writeDurableComposerDraft).toHaveBeenCalledWith(
          sourceScope,
          expect.objectContaining({ text: "Captured source input" }),
          expect.anything(),
        );
      }
      expect(state.chatMessage).toBe("Destination input");
    } finally {
      owner = undefined;
      persistence.stop();
      await settleStorage();
    }
  },
);

it("retires the durable draft when a write notification reveals Incognito metadata", async () => {
  vi.spyOn(draftStore, "readDurableComposerDraft").mockResolvedValue({
    status: "found",
    draft: { revision: 1, text: "Previously stored input", attachments: [], writeId: "previous" },
  });
  const retire = vi.spyOn(draftStore, "retireDurableComposerDraft").mockResolvedValue({
    status: "persisted",
  });
  const state = createState();
  const persistence = new ChatComposerPersistence(() => state);
  persistence.start();
  await settleStorage();
  const capturedScope = persistence.durableScope;
  expect(capturedScope).not.toBeNull();
  vi.mocked(draftStore.writeDurableComposerDraft).mockClear();
  const unsubscribe = subscribeStoredChatOutboxChanges(() => {
    state.selectedChatSessionIncognito = true;
    persistence.persistChangedState();
  });
  try {
    state.chatMessage = "";
    persistence.schedule();
    persistence.persistNow();
    await settleStorage();
    expect(state.selectedChatSessionIncognito).toBe(true);
    expect(retire).toHaveBeenCalledWith(capturedScope, expect.any(Number));
    expect(draftStore.writeDurableComposerDraft).not.toHaveBeenCalled();
    expect(state.chatMessage).toBe("");
  } finally {
    unsubscribe();
    persistence.stop();
    await settleStorage();
  }
});

it("retires private tab input when a pending snapshot predates the authenticated owner", async () => {
  const retire = vi.spyOn(draftStore, "retireDurableComposerDraft").mockResolvedValue({
    status: "persisted",
  });
  const state = createState();
  state.connected = false;
  state.client = { recoveryScope: "", recoveryScopeReady: false };
  state.chatMessage = "Previously persisted private input";
  expect(persistChatComposerState(state)).toBe(true);
  let owner: typeof state | undefined = state;
  const persistence = new ChatComposerPersistence(() => owner);
  persistence.start();
  try {
    state.chatMessage = "Current private input";
    persistence.schedule();
    state.connected = true;
    state.client.recoveryScope = "authenticated-owner";
    state.client.recoveryScopeReady = true;
    state.selectedChatSessionIncognito = true;
    persistence.persistChangedState();
    await settleStorage();
    const stored = sessionStorage.getItem(storageTargetForGateway(state.settings.gatewayUrl).key);
    expect(stored).not.toContain("Previously persisted private input");
    expect(stored).not.toContain("Current private input");
    expect(state.chatMessage).toBe("Current private input");
    expect(retire).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryScope: "authenticated-owner" }),
      expect.any(Number),
    );
  } finally {
    owner = undefined;
    persistence.stop();
    await settleStorage();
  }
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
