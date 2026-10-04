import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import * as durableStore from "../../lib/chat/composer-draft-store.runtime.ts";
import { readChatOutboxRecovery } from "../../lib/chat/outbox-recovery.ts";
import {
  captureChatOutboxAdmission,
  storageTargetForGateway,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  ChatComposerPersistence,
  admitStoredChatComposerQueueItemResult,
  loadChatComposerSnapshot,
  persistChatComposerState,
} from "./composer-persistence.ts";

const state = (account = "account-a", gatewayUrl = "wss://gateway.example") => ({
  client: { recoveryScope: account, recoveryScopeReady: true },
  connected: true,
  settings: { gatewayUrl },
  sessionKey: "agent:main:shared",
  chatMessage: "private draft",
  chatQueue: [],
});
beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("never exposes or overwrites another account's text draft and queue", () => {
  const alice = state();
  expect(persistChatComposerState(alice)).toBe(true);
  expect(
    admitStoredChatComposerQueueItemResult(
      alice,
      captureChatOutboxAdmission(alice, alice.sessionKey),
      { id: "alice", text: "private queued text", createdAt: 1 },
    ),
  ).toBe("admitted");
  const bob = state("account-b");
  expect(loadChatComposerSnapshot(bob, bob.sessionKey)).toBeNull();
  bob.chatMessage = "Bob draft";
  expect(persistChatComposerState(bob)).toBe(true);
  expect(loadChatComposerSnapshot(alice, alice.sessionKey)).toMatchObject({
    draft: "private draft",
    queue: [{ id: "alice" }],
  });
});
it("holds legacy unowned text for review instead of assigning it to the next login", () => {
  const host = state();
  sessionStorage.setItem(
    storageTargetForGateway(host.settings.gatewayUrl).key,
    JSON.stringify({
      version: 4,
      gatewayOwner: host.settings.gatewayUrl,
      recovery: {},
      sessions: {
        [storedChatOutboxScopeKey({ sessionKey: host.sessionKey })]: {
          draft: "legacy draft",
          queue: [{ id: "legacy", text: "legacy queue", createdAt: 1 }],
          updatedAt: 1,
        },
      },
    }),
  );
  expect(loadChatComposerSnapshot(host, host.sessionKey)).toBeNull();
  expect(readChatOutboxRecovery(host).entries).toEqual([
    expect.objectContaining({
      session: expect.objectContaining({
        draft: "legacy draft",
        queue: [expect.objectContaining({ id: "legacy" })],
      }),
    }),
  ]);
});

it("restores account text and attachment drafts before any connection", async () => {
  const online = state();
  expect(persistChatComposerState(online)).toBe(true);
  const client = {
    offlineRecoveryScope: "account-a",
    recoveryScope: "",
    recoveryScopeReady: false,
  };
  let restored!: () => void;
  const applied = new Promise<void>((resolve) => {
    restored = resolve;
  });
  const host = {
    ...state(),
    client,
    connected: false,
    chatMessage: "",
    chatAttachments: [],
    selectedChatSessionIncognito: false,
    requestUpdate: () => restored(),
  };
  expect(loadChatComposerSnapshot(host, host.sessionKey)?.draft).toBe("private draft");
  vi.spyOn(durableStore, "prepareDurableComposerRecovery").mockResolvedValue({
    status: "ready",
    entries: [],
  });
  const read = vi.spyOn(durableStore, "readDurableComposerDraft").mockResolvedValue({
    status: "found",
    draft: {
      text: "attachment draft",
      writeId: "stored-account-a-draft",
      revision: Date.now() + 10,
      attachments: [{ blob: new Blob(["hi"], { type: "text/plain" }), mimeType: "text/plain" }],
    },
  });
  const persistence = new ChatComposerPersistence(() => host);
  persistence.restore();
  persistence.start();
  await vi.dynamicImportSettled();
  await applied;
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ recoveryScope: "account-a" }));
  expect(host.chatMessage).toBe("attachment draft");
  expect(host.chatAttachments).toHaveLength(1);
  persistence.stop();
});
it("keeps offline queue under its captured account through recovery and account replacement", () => {
  const host = {
    ...state(),
    connected: false,
    client: { recoveryScope: "", recoveryScopeReady: false, offlineRecoveryScope: "account-a" },
  };
  const captured = captureChatOutboxAdmission(host, host.sessionKey);
  expect(
    admitStoredChatComposerQueueItemResult(host, captured, {
      id: "offline",
      text: "local",
      createdAt: 1,
    }),
  ).toBe("admitted");
  host.connected = true;
  expect(loadChatComposerSnapshot(host, host.sessionKey)).toBeNull();
  host.client.recoveryScope = "account-b";
  host.client.recoveryScopeReady = true;
  expect(loadChatComposerSnapshot(host, host.sessionKey)).toBeNull();
  expect(
    admitStoredChatComposerQueueItemResult(host, captured, {
      id: "late",
      text: "old account",
      createdAt: 2,
    }),
  ).toBe("storage-failed");
  expect(loadChatComposerSnapshot(state(), host.sessionKey)?.queue.map((item) => item.id)).toEqual([
    "offline",
  ]);
});

it("retired offline admission cannot revive drafts or queue from a remembered client", () => {
  const client = new GatewayBrowserClient({
    url: "wss://gateway.example",
    offlineRecoveryScope: "account-a",
  });
  const host = { ...state(), connected: false, client };
  expect(persistChatComposerState(host)).toBe(true);
  const captured = captureChatOutboxAdmission(host, host.sessionKey);
  client.retireOfflineRecoveryScope();
  expect(loadChatComposerSnapshot(host, host.sessionKey)).toBeNull();
  expect(persistChatComposerState(host)).toBe(false);
  expect(
    admitStoredChatComposerQueueItemResult(host, captured, {
      id: "retired",
      text: "never send",
      createdAt: 1,
    }),
  ).toBe("storage-failed");
  expect(loadChatComposerSnapshot(state(), host.sessionKey)?.draft).toBe("private draft");
});
