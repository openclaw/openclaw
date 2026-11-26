/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import * as durableStore from "../../lib/chat/composer-draft-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination as destinationFor,
  readChatOutboxRecovery as recovery,
  restoreChatOutboxRecovery as restore,
} from "../../lib/chat/outbox-recovery.ts";
import { listStoredChatOutboxes as outboxes } from "../../lib/chat/outbox-store-projection.ts";
import {
  captureChatOutboxAdmission as capture,
  storageTargetForGateway,
  storedChatOutboxScopeKey,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  resumeStoredChatOutboxes as resume,
  retryQueuedChatMessage as retry,
} from "./chat-send-actions.ts";
import {
  loadChatComposerState,
  persistChatComposerState as persist,
} from "./composer-draft-storage.ts";
import { ChatComposerPersistence } from "./composer-persistence.ts";
import { admitStoredChatComposerQueueItemResult as admit } from "./composer-queue-persistence.ts";

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const legacy = { id: "legacy", text: "legacy private input", createdAt: 1 };
function fixture() {
  const host = makeChatHost({
    settings: { gatewayUrl: "wss://gateway.example" },
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [] },
    sessionKey: "agent:main:shared",
    chatMessage: "",
    requestHandlers: {},
  });
  let account = "account-a";
  Object.defineProperty(host.client, "recoveryScope", { get: () => account });
  return {
    host,
    switchAccount: (next = "account-b") => {
      account = next;
    },
  };
}
function seedUnowned(host: ReturnType<typeof fixture>["host"], account?: string) {
  const key = storageTargetForGateway(host.settings.gatewayUrl, account).key;
  const raw = JSON.stringify({
    version: 4,
    gatewayOwner: host.settings.gatewayUrl,
    recovery: {},
    sessions: {
      [storedChatOutboxScopeKey({ sessionKey: host.sessionKey })]: {
        draft: "legacy draft",
        queue: [legacy],
        updatedAt: 1,
      },
    },
  });
  sessionStorage.setItem(key, raw);
  return { key, raw };
}

it.each(["recovery", "direct"])(
  "stamps %s admission before a subscriber replaces its account",
  async (mode) => {
    const { host, switchAccount } = fixture();
    const captured = capture(host, host.sessionKey);
    if (mode === "recovery") {
      const source = seedUnowned(host);
      await resume(host);
      expect(outboxes(host)).toEqual([]);
      expect(loadChatComposerState(host, host.sessionKey).snapshot).toBeNull();
      expect(recovery(host).entries).toMatchObject([
        { session: { draft: "legacy draft", queue: [{ id: "legacy" }] } },
      ]);
      expect(sessionStorage.getItem(source.key)).toBe(source.raw);
    }
    const [entry] = recovery(host).entries;
    const destination = destinationFor(host, { sessionKey: host.sessionKey });
    if (mode === "recovery") {
      expect(entry?.session.queue?.[0]?.storageScope).toBeUndefined();
      expect(destination).not.toBeNull();
    }
    let recoveredIds: string[] = [];
    const unsubscribe = subscribeStoredChatOutboxChanges(() => {
      // Recovery publishes before the pane's account-change lifecycle.
      host.chatQueue = loadChatComposerState(host, host.sessionKey).snapshot?.queue ?? [];
      recoveredIds = host.chatQueue.map((item) => item.id);
      switchAccount();
      chatOutboxOwner(host).syncHost(host);
    });
    try {
      expect(
        mode === "recovery"
          ? restore(host, entry!, destination!)
          : admit(host, captured, { id: "fresh", text: "A input", createdAt: 1 }),
      ).toBe(mode === "recovery" ? "restored" : "admitted");
    } finally {
      unsubscribe();
    }
    expect(host.chatQueue).toEqual([]);
    if (mode === "direct") {
      expect(outboxes(fixture().host)[0]?.queue[0]).toMatchObject({
        id: "fresh",
        storageScope: JSON.stringify([host.settings.gatewayUrl, "account-a"]),
      });
      return;
    }
    await resume(host);
    await retry(host, "legacy");
    expect(requestCalls(host.request, "chat.send")).toEqual([]);
    expect(recovery(host).entries).toEqual([]);
    expect(recoveredIds).toEqual(["legacy"]);
    switchAccount("account-a");
    await resume(host);
    expect(requestCalls(host.request, "chat.send")).toEqual([]);
    expect(host.chatQueue).toMatchObject([
      {
        id: "legacy",
        text: "legacy private input",
        sendState: "failed",
        storageScope: JSON.stringify([host.settings.gatewayUrl, "account-a"]),
      },
    ]);
  },
);

it("never projects or drains unowned rows from an account-qualified bucket", async () => {
  const { host } = fixture();
  const source = seedUnowned(host, "account-a");
  host.chatQueue = [{ ...legacy }];
  await resume(host);
  expect(host.chatQueue).toEqual([]);
  expect(outboxes(host)).toEqual([]);
  expect(requestCalls(host.request, "chat.send")).toEqual([]);
  expect(sessionStorage.getItem(source.key)).toBe(source.raw);
});

const accountState = (account = "account-a") => ({
  client: { recoveryScope: account, recoveryScopeReady: true },
  connected: true,
  settings: { gatewayUrl: "wss://gateway.example" },
  sessionKey: "agent:main:shared",
  chatMessage: "private draft",
  chatQueue: [],
});
type AccountHost = Parameters<typeof admit>[0] & { sessionKey: string };
const snapshot = (host: AccountHost) => loadChatComposerState(host, host.sessionKey).snapshot;
const item = (id: string, text: string, createdAt = 1) => ({ id, text, createdAt });
const offline = () => ({
  ...accountState(),
  connected: false,
  client: { recoveryScope: "", recoveryScopeReady: false, offlineRecoveryScope: "account-a" },
});

it("never exposes or overwrites another account's text draft and queue", () => {
  const alice = accountState();
  expect(persist(alice)).toBe(true);
  expect(admit(alice, capture(alice, alice.sessionKey), item("alice", "private queued text"))).toBe(
    "admitted",
  );
  const bob = accountState("account-b");
  expect(snapshot(bob)).toBeNull();
  bob.chatMessage = "Bob draft";
  expect(persist(bob)).toBe(true);
  expect(snapshot(alice)).toMatchObject({ draft: "private draft", queue: [{ id: "alice" }] });
});

it("restores account text and attachment drafts before any connection", async () => {
  expect(persist(accountState())).toBe(true);
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
  expect(snapshot(accountState())?.queue.map((queued) => queued.id)).toEqual(["offline"]);
});

it("retired offline admission cannot revive drafts or queue from a remembered client", () => {
  const client = new GatewayBrowserClient({
    url: "wss://gateway.example",
    offlineRecoveryScope: "account-a",
  });
  const host = { ...accountState(), connected: false, client };
  expect(persist(host)).toBe(true);
  const captured = capture(host, host.sessionKey);
  client.retireOfflineRecoveryScope();
  expect(snapshot(host)).toBeNull();
  expect(persist(host)).toBe(false);
  expect(admit(host, captured, item("retired", "never send"))).toBe("storage-failed");
  expect(snapshot(accountState())?.draft).toBe("private draft");
});
