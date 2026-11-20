import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  cacheChatSessionSnapshot,
  observeChatCache,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import { writeSnapshotFixture } from "./session-snapshot.test-support.ts";

export const snapshotHost = {
  settings: { gatewayUrl: "wss://cache.example" },
  client: { recoveryScope: "account-a", recoveryScopeReady: true },
  assistantAgentId: "main",
  agentsList: null,
  hello: null,
};
export const key = (sessionKey: string) => resolveChatSnapshotKey(snapshotHost, { sessionKey });
export const rawKey = (cacheKey: string) => cacheKey.slice(cacheKey.indexOf("\u0000") + 1);
export const sessionKey = key("agent:main:session");
export function snapshot(
  message: unknown = "conversation",
  sessionId = "session-1",
): ChatSessionSnapshot {
  return {
    displayedLeafEntryId: "leaf-1",
    messages: [message],
    pagination: { hasMore: true, nextOffset: 1, totalMessages: 2 },
    sessionId,
  };
}

export const readSnapshot = (cacheKey = sessionKey) => new SessionSnapshotStore().read(cacheKey);
export function cacheSnapshot(
  memory: ChatMessageCache,
  cacheKey: string,
  value = snapshot(cacheKey),
) {
  cacheChatSessionSnapshot(memory, snapshotHost, { sessionKey: rawKey(cacheKey) }, value);
}
export async function persist(
  store: SessionSnapshotStore,
  cacheKey: string,
  value: ChatSessionSnapshot,
) {
  writeSnapshotFixture(store, cacheKey, value);
  await store.flush();
}

export function useSessionSnapshotStoreFixture() {
  const connected = new Set<SessionSnapshotStore>();
  function makeStore(memory?: ChatMessageCache, connect = false) {
    const store = new SessionSnapshotStore(memory);
    if (memory) {
      observeChatCache(memory, store);
    }
    if (connect) {
      store.connect();
      connected.add(store);
    }
    return store;
  }
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(async () => {
    for (const store of connected) {
      store.disconnect();
      await store.whenIdle();
    }
    connected.clear();
    await clearStoredChatSnapshots();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  return { connected, makeStore };
}
