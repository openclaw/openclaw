// Session store writer tests cover serialized session writes and cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test-utils/deferred.js";
import {
  clearSessionStoreCacheForTest,
  getSessionStoreWriterQueueSizeForTest,
  withSessionStoreWriterForTest,
} from "./store.js";

describe("session store writer", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
  });

  it("serializes runtime writes through one in-process writer", async () => {
    const storePath = "/tmp/openclaw-store.json";
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const order: string[] = [];

    const first = withSessionStoreWriterForTest(storePath, async () => {
      order.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first:end");
    });
    const second = withSessionStoreWriterForTest(storePath, async () => {
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

  it("holds a cross-process file lock while running a writer", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-writer-"));
    const storePath = path.join(tempDir, "sessions.json");
    const started = createDeferred<void>();
    const release = createDeferred<void>();

    const write = withSessionStoreWriterForTest(storePath, async () => {
      started.resolve();
      await release.promise;
    });

    await started.promise;
    await expect(fs.access(`${storePath}.lock`)).resolves.toBeUndefined();
    release.resolve();
    await write;
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  it("rejects empty store paths before enqueuing work", async () => {
    await expect(withSessionStoreWriterForTest("", async () => undefined)).rejects.toThrow(
      /storePath must be a non-empty string/,
    );
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(0);
  });
});
