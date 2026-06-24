// Session store writer tests cover serialized session writes and cleanup.
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test-utils/deferred.js";
import { runExclusiveSessionStoreWrite } from "./store-writer.js";
import { clearSessionStoreCacheForTest, getSessionStoreWriterQueueSizeForTest } from "./store.js";

describe("session store writer", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
  });

  it("serializes runtime writes through one in-process writer", async () => {
    const storePath = "/tmp/openclaw-store.json";
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const order: string[] = [];

    const first = runExclusiveSessionStoreWrite(storePath, async () => {
      order.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first:end");
    });
    const second = runExclusiveSessionStoreWrite(storePath, async () => {
      order.push("second");
    });

    await firstStarted.promise;
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(1);
    expect(order).toEqual(["first:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(0);
  });

  it("rejects empty store paths before enqueuing work", async () => {
    await expect(runExclusiveSessionStoreWrite("", async () => undefined)).rejects.toThrow(
      /storePath must be a non-empty string/,
    );
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(0);
  });
});
