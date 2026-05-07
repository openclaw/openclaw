import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionStoreCacheForTest,
  getSessionStoreWriterQueueSizeForTest,
  loadSessionStore,
  withSessionStoreWriterForTest,
} from "./store.js";

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));

describe("session store writer", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
  });

  it("serializes runtime writes through one in-process writer", async () => {
    const storePath = "/tmp/openclaw-store.json";
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
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

  it("rejects empty store paths before enqueuing work", async () => {
    await expect(withSessionStoreWriterForTest("", async () => undefined)).rejects.toThrow(
      /storePath must be a non-empty string/,
    );
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(0);
  });

  it("serializes session store updates across worker threads", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-writer-"));
    try {
      const storePath = path.join(tmpDir, "sessions.json");
      await fs.writeFile(storePath, "{}\n", "utf8");
      const source = `
        const { updateSessionStore } = await import("./src/config/sessions/store.ts");

        await updateSessionStore(process.env.OPENCLAW_TEST_STORE_PATH, async (store) => {
          store[process.env.OPENCLAW_TEST_SESSION_KEY] = {
            sessionId: process.env.OPENCLAW_TEST_SESSION_KEY,
            updatedAt: Date.now()
          };
          await new Promise((resolve) => setTimeout(resolve, 75));
        });
      `;
      const workers = Array.from({ length: 4 }, (_, index) =>
        execFileAsync(process.execPath, ["--import", "tsx", "--eval", source], {
          cwd: path.resolve(testDir, "../../.."),
          env: {
            ...process.env,
            OPENCLAW_TEST_SESSION_KEY: `agent:worker:${index}`,
            OPENCLAW_TEST_STORE_PATH: storePath,
          },
        }),
      );

      await Promise.all(workers);

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(Object.keys(store).toSorted()).toEqual([
        "agent:worker:0",
        "agent:worker:1",
        "agent:worker:2",
        "agent:worker:3",
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
