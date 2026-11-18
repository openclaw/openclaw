/* @vitest-environment jsdom */

import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import {
  CHAT_SNAPSHOT_STORE_NAME,
  openSessionSnapshotDatabase,
} from "./session-snapshot-database.ts";
import {
  clearStoredChatSnapshots,
  deleteStoredChatSnapshot,
} from "./session-snapshot-invalidation.ts";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["scope", "session"] as const)(
  "reports an aborted %s clear while keeping single-session eviction best effort",
  async (scope) => {
    const prefix = 'scope:["wss://cache.example","account-a"]\u0000';
    const sessionKey = `${prefix}agent:main:aborted-clear`;
    const database = await openSessionSnapshotDatabase();
    if (!database) {
      throw new Error("Expected snapshot database");
    }
    try {
      const write = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
      const written = transactionComplete(write);
      write.objectStore(CHAT_SNAPSHOT_STORE_NAME).put({ sessionKey });
      await written;
      const transaction = database.transaction.bind(database);
      vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce((...args) => {
        const pending = transaction(...args);
        queueMicrotask(() => pending.abort());
        return pending;
      });

      const clearing =
        scope === "scope" ? clearStoredChatSnapshots(prefix) : deleteStoredChatSnapshot(sessionKey);
      if (scope === "scope") {
        await expect(clearing).rejects.toThrow("IndexedDB transaction");
      } else {
        await expect(clearing).resolves.toBeUndefined();
      }
      const read = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readonly");
      const completed = transactionComplete(read);
      expect(
        await requestResult(read.objectStore(CHAT_SNAPSHOT_STORE_NAME).get(sessionKey)),
      ).toEqual({
        sessionKey,
      });
      await completed;
    } finally {
      database.close();
    }
  },
);
