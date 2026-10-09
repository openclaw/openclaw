/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import {
  captureChatOutboxAdmission,
  storageTargetForGateway,
  storedChatOutboxScopeKey,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { resumeStoredChatOutboxes, retryQueuedChatMessage } from "./chat-send-actions.ts";
import {
  admitStoredChatComposerQueueItemResult,
  listStoredChatOutboxes,
  loadChatComposerState,
} from "./composer-persistence.ts";

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
        queue: [{ id: "legacy", text: "legacy private input", createdAt: 1 }],
        updatedAt: 1,
      },
    },
  });
  sessionStorage.setItem(key, raw);
  return { key, raw };
}

it("stamps explicit legacy recovery before reentrant account replacement and never sends it as B", async () => {
  const { host, switchAccount } = fixture();
  const source = seedUnowned(host);
  await resumeStoredChatOutboxes(host);
  expect(listStoredChatOutboxes(host)).toEqual([]);
  expect(sessionStorage.getItem(source.key)).toBe(source.raw);
  const [entry] = readChatOutboxRecovery(host).entries;
  expect(entry?.session.queue?.[0]?.storageScope).toBeUndefined();
  const destination = captureChatOutboxRecoveryDestination(host, { sessionKey: host.sessionKey });
  expect(destination).not.toBeNull();
  let recoveredIds: string[] = [];
  const unsubscribe = subscribeStoredChatOutboxChanges(() => {
    // Recovery publishes synchronously, before the pane's account-change lifecycle runs.
    host.chatQueue = loadChatComposerState(host, host.sessionKey).snapshot?.queue ?? [];
    recoveredIds = host.chatQueue.map((item) => item.id);
    switchAccount();
    chatOutboxOwner(host).syncHost(host);
  });
  try {
    expect(restoreChatOutboxRecovery(host, entry!, destination!)).toBe("restored");
  } finally {
    unsubscribe();
  }
  expect(host.chatQueue).toEqual([]);
  await resumeStoredChatOutboxes(host);
  await retryQueuedChatMessage(host, "legacy");
  expect(requestCalls(host.request, "chat.send")).toEqual([]);
  expect(readChatOutboxRecovery(host).entries).toEqual([]);
  expect(recoveredIds).toEqual(["legacy"]);
  switchAccount("account-a");
  await resumeStoredChatOutboxes(host);
  expect(requestCalls(host.request, "chat.send")).toEqual([]);
  expect(host.chatQueue).toEqual([
    expect.objectContaining({
      id: "legacy",
      text: "legacy private input",
      storageScope: JSON.stringify([host.settings.gatewayUrl, "account-a"]),
      sendState: "failed",
    }),
  ]);
});

it("stamps direct queue admission before subscribers can replace the mutable client owner", () => {
  const { host, switchAccount } = fixture();
  const captured = captureChatOutboxAdmission(host, host.sessionKey);
  const unsubscribe = subscribeStoredChatOutboxChanges(() => {
    host.chatQueue = loadChatComposerState(host, host.sessionKey).snapshot?.queue ?? [];
    switchAccount();
    chatOutboxOwner(host).syncHost(host);
  });
  try {
    expect(
      admitStoredChatComposerQueueItemResult(host, captured, {
        id: "fresh",
        text: "A input",
        createdAt: 1,
      }),
    ).toBe("admitted");
  } finally {
    unsubscribe();
  }
  expect(host.chatQueue).toEqual([]);
  expect(listStoredChatOutboxes(fixture().host)[0]?.queue[0]).toMatchObject({
    id: "fresh",
    storageScope: JSON.stringify([host.settings.gatewayUrl, "account-a"]),
  });
});

it("never projects or drains raw unowned rows even from an account-qualified bucket", async () => {
  const { host } = fixture();
  const source = seedUnowned(host, "account-a");
  host.chatQueue = [{ id: "legacy", text: "legacy private input", createdAt: 1 }];
  await resumeStoredChatOutboxes(host);
  expect(host.chatQueue).toEqual([]);
  expect(listStoredChatOutboxes(host)).toEqual([]);
  expect(requestCalls(host.request, "chat.send")).toEqual([]);
  expect(sessionStorage.getItem(source.key)).toBe(source.raw);
});

it("does not publish a stale unowned admission as the replacement account's local input", () => {
  const { host, switchAccount } = fixture();
  const captured = captureChatOutboxAdmission(host, host.sessionKey);
  switchAccount();
  const owner = chatOutboxOwner(host);
  expect(owner.admit(host, captured, { id: "late", text: "A input", createdAt: 1 })).toBe(
    "storage-failed",
  );
  expect(host.chatQueue).toEqual([]);
  expect(chatOutboxOwner(host).allItems(host)).toEqual([]);
});
