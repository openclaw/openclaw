import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearSessionStoreCacheForTest,
  withSessionStoreLockForTest,
} from "./store.js";

describe("withSessionStoreLock", () => {
  it("defaults staleMs to <= timeoutMs so contended live locks can be reclaimed before timing out", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-lock-"));
    try {
      const storePath = path.join(root, "sessions.jsonl");
      const lockPath = `${storePath}.lock`;

      // Simulate a contended lock held by a *live* pid. The only way to reclaim
      // this before timing out is if the lock becomes stale before the timeout.
      await fs.writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            createdAt: new Date(Date.now() - 1_000).toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );

      await expect(
        withSessionStoreLockForTest(
          storePath,
          async () => "ok",
          {
            timeoutMs: 100,
            // Important: do NOT provide staleMs; this test asserts the default.
          },
        ),
      ).resolves.toBe("ok");
    } finally {
      clearSessionStoreCacheForTest();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
