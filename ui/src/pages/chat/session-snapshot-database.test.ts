import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { requestResult } from "../../lib/chat/control-ui-database.runtime.ts";
import {
  CHAT_SNAPSHOT_DB_NAME,
  CHAT_SNAPSHOT_METADATA_STORE_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
  SIDEBAR_SNAPSHOT_STORE_NAME,
  openSessionSnapshotDatabase,
} from "./session-snapshot-database.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("finishes migration and releases a blocked open after its caller has given up", async () => {
  const factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  vi.spyOn(console, "debug").mockImplementation(() => {});
  const seed = factory.open(CHAT_SNAPSHOT_DB_NAME, 7);
  seed.addEventListener("upgradeneeded", () => {
    for (const name of [
      CHAT_SNAPSHOT_STORE_NAME,
      CHAT_SNAPSHOT_METADATA_STORE_NAME,
      SIDEBAR_SNAPSHOT_STORE_NAME,
    ]) {
      seed.result.createObjectStore(name, { keyPath: "sessionKey" }).put({ sessionKey: "retired" });
    }
  });
  const older = await requestResult(seed);
  let abandoned: IDBDatabase | undefined;
  try {
    const opens = vi.spyOn(factory, "open");
    const opening = openSessionSnapshotDatabase();
    const late = requestResult<IDBDatabase>(opens.mock.results[0]!.value);
    await expect(opening).resolves.toBeNull();
    older.close();
    abandoned = await late;

    const current = await requestResult(factory.open(CHAT_SNAPSHOT_DB_NAME));
    try {
      expect(
        await requestResult(
          current
            .transaction(CHAT_SNAPSHOT_STORE_NAME)
            .objectStore(CHAT_SNAPSHOT_STORE_NAME)
            .getAll(),
        ),
      ).toEqual([]);
    } finally {
      current.close();
    }

    const deleting = factory.deleteDatabase(CHAT_SNAPSHOT_DB_NAME);
    const deleted = requestResult(deleting);
    const outcome = new Promise<string>((resolve) => {
      deleting.addEventListener("success", () => resolve("deleted"), { once: true });
      deleting.addEventListener("blocked", () => resolve("blocked"), { once: true });
    });
    try {
      expect(await outcome).toBe("deleted");
    } finally {
      abandoned.close();
      await deleted;
    }
  } finally {
    older.close();
    abandoned?.close();
  }
});
