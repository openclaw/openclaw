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
type Host = Parameters<typeof admitStoredChatComposerQueueItemResult>[0] & { sessionKey: string };
const admit = (
  host: Host,
  captured: ReturnType<typeof captureChatOutboxAdmission>,
  id: string,
  text: string,
  createdAt = 1,
) => admitStoredChatComposerQueueItemResult(host, captured, { id, text, createdAt });
const snapshot = (host: Host) => loadChatComposerState(host, host.sessionKey).snapshot;
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
    admit(
      alice,
      captureChatOutboxAdmission(alice, alice.sessionKey),
      "alice",
      "private queued text",
    ),
  ).toBe("admitted");
  const bob = state("account-b");
  expect(snapshot(bob)).toBeNull();
  bob.chatMessage = "Bob draft";
  expect(persistChatComposerState(bob)).toBe(true);
  expect(snapshot(alice)).toMatchObject({
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
  expect(snapshot(host)).toBeNull();
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
  const host = {
    ...state(),
    client,
    connected: false,
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
  const host = {
    ...state(),
    connected: false,
    client: { recoveryScope: "", recoveryScopeReady: false, offlineRecoveryScope: "account-a" },
  };
  const captured = captureChatOutboxAdmission(host, host.sessionKey);
  expect(admit(host, captured, "offline", "local")).toBe("admitted");
  host.connected = true;
  expect(snapshot(host)).toBeNull();
  host.client.recoveryScope = "account-b";
  host.client.recoveryScopeReady = true;
  expect(snapshot(host)).toBeNull();
  expect(admit(host, captured, "late", "old account", 2)).toBe("storage-failed");
  expect(snapshot(state())?.queue.map((item) => item.id)).toEqual(["offline"]);
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
  expect(snapshot(host)).toBeNull();
  expect(persistChatComposerState(host)).toBe(false);
  expect(admit(host, captured, "retired", "never send")).toBe("storage-failed");
  expect(snapshot(state())?.draft).toBe("private draft");
});
