/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  captureChatOutboxRecoveryDestination as destinationFor,
  readChatOutboxRecovery as recovery,
  restoreChatOutboxRecovery as restore,
} from "../../lib/chat/outbox-recovery.ts";
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
  admitStoredChatComposerQueueItemResult as admit,
  listStoredChatOutboxes as outboxes,
  loadChatComposerState,
} from "./composer-persistence.ts";

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
