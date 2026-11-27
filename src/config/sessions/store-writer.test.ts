// Session store writer tests cover serialized session writes and cleanup.
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearSessionStoreCacheForTest } from "./store-writer-state.js";
import { runExclusiveSessionStoreWrite } from "./store-writer.js";

describe("session store writer", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
  });

  it("does not leak active writer state to async children after the writer returns", async () => {
    const storePath = "/tmp/openclaw-store.json";
    const order: string[] = [];
    const childReleased = createDeferred();
    let child: Promise<string> = Promise.resolve("not-started");

    await runExclusiveSessionStoreWrite(storePath, async () => {
      child = (async () => {
        await childReleased.promise;
        return await runExclusiveSessionStoreWrite(storePath, async () => {
          order.push("child");
          return "child-result";
        });
      })();
    });

    const blockerReleased = createDeferred();
    const blockerStarted = createDeferred();
    const blocker = runExclusiveSessionStoreWrite(storePath, async () => {
      order.push("blocker:start");
      blockerStarted.resolve();
      await blockerReleased.promise;
      order.push("blocker:end");
    });
    await blockerStarted.promise;

    childReleased.resolve();
    await Promise.resolve();
    expect(order).toEqual(["blocker:start"]);

    blockerReleased.resolve();
    await Promise.all([blocker, child]);

    expect(order).toEqual(["blocker:start", "blocker:end", "child"]);
    expect(await child).toBe("child-result");
  });

  it("rejects empty store paths before enqueuing work", async () => {
    await expect(runExclusiveSessionStoreWrite("", async () => undefined)).rejects.toThrow(
      /storePath must be a non-empty string/,
    );
  });
});
