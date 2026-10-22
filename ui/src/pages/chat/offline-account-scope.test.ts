import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import * as durableStore from "../../lib/chat/composer-draft-store.runtime.ts";
import { captureChatOutboxAdmission as capture } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  ChatComposerPersistence,
  admitStoredChatComposerQueueItemResult as admit,
  loadChatComposerState,
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
type Host = Parameters<typeof admit>[0] & { sessionKey: string };
const item = (id: string, text: string, createdAt = 1) => ({ id, text, createdAt });
const snapshot = (host: Host) => loadChatComposerState(host, host.sessionKey).snapshot;
const offline = () => ({
  ...state(),
  connected: false,
  client: { recoveryScope: "", recoveryScopeReady: false, offlineRecoveryScope: "account-a" },
});
beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("never exposes or overwrites another account's text draft and queue", () => {
  const alice = state();
  expect(persistChatComposerState(alice)).toBe(true);
  expect(admit(alice, capture(alice, alice.sessionKey), item("alice", "private queued text"))).toBe(
    "admitted",
  );
  const bob = state("account-b");
  expect(snapshot(bob)).toBeNull();
  bob.chatMessage = "Bob draft";
  expect(persistChatComposerState(bob)).toBe(true);
  expect(snapshot(alice)).toMatchObject({
    draft: "private draft",
    queue: [{ id: "alice" }],
  });
});
it("restores account text and attachment drafts before any connection", async () => {
  expect(persistChatComposerState(state())).toBe(true);
  const host = {
    ...offline(),
    chatMessage: "",
    chatAttachments: [],
    selectedChatSessionIncognito: false,
  };
  expect(snapshot(host)?.draft).toBe("private draft");
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
  await vi.waitFor(() => expect(host.chatMessage).toBe("attachment draft"));
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ recoveryScope: "account-a" }));
  expect(host.chatAttachments).toHaveLength(1);
  persistence.stop();
});
it("keeps offline queue under its captured account through recovery and account replacement", () => {
  const host = offline();
  const captured = capture(host, host.sessionKey);
  expect(admit(host, captured, item("offline", "local"))).toBe("admitted");
  host.connected = true;
  expect(snapshot(host)).toBeNull();
  host.client.recoveryScope = "account-b";
  host.client.recoveryScopeReady = true;
  expect(snapshot(host)).toBeNull();
  expect(admit(host, captured, item("late", "old account", 2))).toBe("storage-failed");
  const owner = chatOutboxOwner(host);
  expect(owner.admit(host, captured, item("late", "old account", 2))).toBe("storage-failed");
  expect(host.chatQueue).toEqual([]);
  expect(owner.allItems(host)).toEqual([]);
  expect(snapshot(state())?.queue.map((queued) => queued.id)).toEqual(["offline"]);
});

it("retired offline admission cannot revive drafts or queue from a remembered client", () => {
  const client = new GatewayBrowserClient({
    url: "wss://gateway.example",
    offlineRecoveryScope: "account-a",
  });
  const host = { ...state(), connected: false, client };
  expect(persistChatComposerState(host)).toBe(true);
  const captured = capture(host, host.sessionKey);
  client.retireOfflineRecoveryScope();
  expect(snapshot(host)).toBeNull();
  expect(persistChatComposerState(host)).toBe(false);
  expect(admit(host, captured, item("retired", "never send"))).toBe("storage-failed");
  expect(snapshot(state())?.draft).toBe("private draft");
});
