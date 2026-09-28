import rawFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readChatHistoryCliSessionImportSnapshot } from "./cli-session-history.js";
import { requireGatewayRecord } from "./test-helpers.assertions.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["success", "failure"] as const)(
  "shares interleaved pending Claude reads and retires them after %s",
  async (outcome) => {
    const homeDir = tempDirs.make("openclaw-claude-interleaved-");
    const projectsDir = path.join(homeDir, ".claude", "projects", "workspace");
    await fs.mkdir(projectsDir, { recursive: true });
    for (const sessionId of ["first", "second"]) {
      await fs.writeFile(
        path.join(projectsDir, `${sessionId}.jsonl`),
        JSON.stringify({
          type: "user",
          uuid: `${sessionId}-message`,
          message: { role: "user", content: `${sessionId} transcript` },
        }),
      );
    }
    const firstPath = await fs.realpath(path.join(projectsDir, "first.jsonl"));
    const secondPath = await fs.realpath(path.join(projectsDir, "second.jsonl"));
    const firstOpenStarted = createDeferred();
    const releaseFirstOpen = createDeferred();
    const createReadStream = rawFs.createReadStream;
    const stat = fs.stat;
    let firstStats = 0;
    let failFirstOpen = outcome === "failure";
    const reads: Promise<unknown[]>[] = [];
    const read = (sessionId: string) => {
      const pending = readChatHistoryCliSessionImportSnapshot({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: 0,
          cliSessionBindings: { "claude-cli": { sessionId } },
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      reads.push(pending);
      return pending;
    };
    const streamSpy = vi.spyOn(rawFs, "createReadStream").mockImplementation((file, options) => {
      if (file !== firstPath) {
        return createReadStream(file, options);
      }
      return createReadStream(file, {
        ...(typeof options === "string" ? { encoding: options } : options),
        fs: {
          open(openedPath, flags, mode, callback) {
            firstOpenStarted.resolve();
            void releaseFirstOpen.promise.then(() => {
              if (failFirstOpen) {
                callback(new Error("synthetic read failure"), -1);
              } else {
                rawFs.open(openedPath, flags, mode, callback);
              }
            });
          },
          read: rawFs.read,
          close: rawFs.close,
        },
      });
    });
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (args[0] === firstPath && ++firstStats === 2) {
        // The repeated read has its fingerprint before the held file can open.
        releaseFirstOpen.resolve();
      }
      return result;
    });
    try {
      const firstRead = read("first");
      await firstOpenStarted.promise;
      expect(await read("second")).toMatchObject([{ content: "second transcript" }]);
      const [first, repeated] = await Promise.all([firstRead, read("first")]);
      expect(first).toMatchObject(outcome === "success" ? [{ content: "first transcript" }] : []);
      expect(repeated).toEqual(first);
      expect(streamSpy.mock.calls.filter(([file]) => file === firstPath)).toHaveLength(1);
      if (outcome === "success") {
        requireGatewayRecord(first[0], "first snapshot message").content = "caller-only edit";
        expect(repeated).toMatchObject([{ content: "first transcript" }]);
      }
      failFirstOpen = false;
      expect(await read("first")).toMatchObject([{ content: "first transcript" }]);
      expect(streamSpy.mock.calls.filter(([file]) => file === firstPath)).toHaveLength(
        outcome === "success" ? 1 : 2,
      );
      // Completed imports still retain only the most recently requested snapshot.
      expect(await read("second")).toMatchObject([{ content: "second transcript" }]);
      expect(streamSpy.mock.calls.filter(([file]) => file === secondPath)).toHaveLength(2);
    } finally {
      releaseFirstOpen.resolve();
      await Promise.allSettled(reads);
      statSpy.mockRestore();
      streamSpy.mockRestore();
    }
  },
);

it("projects oversized Claude messages off-thread using one worker per snapshot", async () => {
  const homeDir = tempDirs.make("openclaw-claude-snapshot-");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const record = (uuid: string, content: string) =>
    JSON.stringify({
      type: "user",
      uuid,
      timestamp: "2026-03-26T16:29:54.700Z",
      message: { role: "user", content },
    });
  const oversized = "q".repeat(2 * 1024 * 1024);
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(
    path.join(projectsDir, `${sessionId}.jsonl`),
    [
      record("oversized-user-0", oversized),
      "!".repeat(2 * 1024 * 1024),
      record("oversized-user-1", oversized),
      record("oversized-user-2", oversized),
      record("visible-after-oversized", "visible"),
    ].join("\n"),
    "utf8",
  );
  const parseSpy = vi.spyOn(JSON, "parse");
  const workers: Worker[] = [];
  const onWorker = (worker: Worker) => workers.push(worker);
  process.on("worker", onWorker);
  try {
    const messages = await readChatHistoryCliSessionImportSnapshot({
      entry: {
        sessionId: "openclaw-session",
        updatedAt: Date.now(),
        cliSessionBindings: { "claude-cli": { sessionId } },
      },
      provider: "claude-cli",
      localMessages: [],
      homeDir,
    });

    expect(messages).toHaveLength(4);
    for (let index = 0; index < 3; index++) {
      expect(messages[index]).toMatchObject({
        __openclaw: { externalId: `oversized-user-${index}` },
        content: expect.stringContaining("exceeded 1 MiB"),
      });
    }
    expect(messages[3]).toMatchObject({
      __openclaw: { externalId: "visible-after-oversized" },
      content: "visible",
    });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.threadId).toBe(-1);
    expect(
      parseSpy.mock.calls.some(
        ([source]) => typeof source === "string" && source.length > 1024 * 1024,
      ),
    ).toBe(false);
  } finally {
    process.off("worker", onWorker);
    parseSpy.mockRestore();
  }
});
