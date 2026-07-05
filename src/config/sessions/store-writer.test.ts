// Session store writer tests cover serialized session writes and cleanup.
import { afterEach, describe, expect, it } from "vitest";
<<<<<<< HEAD
import { createDeferred } from "../../test-utils/deferred.js";
import { runExclusiveSessionStoreWrite } from "./store-writer.js";
import { clearSessionStoreCacheForTest, getSessionStoreWriterQueueSizeForTest } from "./store.js";
=======
import {
  clearSessionStoreCacheForTest,
  getSessionStoreWriterQueueSizeForTest,
  withSessionStoreWriterForTest,
} from "./store.js";

const createDeferred = <T>() => {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
};
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

describe("session store writer", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
  });

  it("serializes runtime writes through one in-process writer", async () => {
    const storePath = "/tmp/openclaw-store.json";
<<<<<<< HEAD
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const order: string[] = [];

    const first = runExclusiveSessionStoreWrite(storePath, async () => {
=======
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const order: string[] = [];

    const first = withSessionStoreWriterForTest(storePath, async () => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      order.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first:end");
    });
<<<<<<< HEAD
    const second = runExclusiveSessionStoreWrite(storePath, async () => {
=======
    const second = withSessionStoreWriterForTest(storePath, async () => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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

<<<<<<< HEAD
  it("runs nested writes for the active store without requeueing behind itself", async () => {
    const storePath = "/tmp/openclaw-store.json";
    const order: string[] = [];

    const result = await runExclusiveSessionStoreWrite(storePath, async () => {
      order.push("outer:start");
      const nested = await runExclusiveSessionStoreWrite(
        storePath,
        async () => {
          order.push("inner");
          return "nested-result";
        },
        { reentrant: true },
      );
      order.push("outer:end");
      return nested;
    });

    expect(result).toBe("nested-result");
    expect(order).toEqual(["outer:start", "inner", "outer:end"]);
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(0);
  });

  it("does not leak active writer state to async children after the writer returns", async () => {
    const storePath = "/tmp/openclaw-store.json";
    const order: string[] = [];
    let releaseChild = () => {};
    const childReleased = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let child: Promise<string> = Promise.resolve("not-started");

    await runExclusiveSessionStoreWrite(storePath, async () => {
      child = (async () => {
        await childReleased;
        return await runExclusiveSessionStoreWrite(storePath, async () => {
          order.push("child");
          return "child-result";
        });
      })();
    });

    let releaseBlocker = () => {};
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let markBlockerStarted = () => {};
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve;
    });
    const blocker = runExclusiveSessionStoreWrite(storePath, async () => {
      order.push("blocker:start");
      markBlockerStarted();
      await blockerReleased;
      order.push("blocker:end");
    });
    await blockerStarted;

    releaseChild();
    await Promise.resolve();
    expect(order).toEqual(["blocker:start"]);

    releaseBlocker();
    await Promise.all([blocker, child]);

    expect(order).toEqual(["blocker:start", "blocker:end", "child"]);
    expect(await child).toBe("child-result");
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(0);
  });

  it("rejects empty store paths before enqueuing work", async () => {
    await expect(runExclusiveSessionStoreWrite("", async () => undefined)).rejects.toThrow(
=======
  it("rejects empty store paths before enqueuing work", async () => {
    await expect(withSessionStoreWriterForTest("", async () => undefined)).rejects.toThrow(
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      /storePath must be a non-empty string/,
    );
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(0);
  });
});
