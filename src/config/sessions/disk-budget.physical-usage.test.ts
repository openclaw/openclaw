import { channel } from "node:diagnostics_channel";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  hasRetainedSessionTranscriptArchives,
  measureSessionPhysicalDiskUsage,
  pruneSessionTranscriptArchivesToHighWater,
} from "./disk-budget.js";

const workers: Worker[] = [];
const workerChannel = channel("worker_threads");
const trackWorker = (message: unknown) => workers.push((message as { worker: Worker }).worker);

beforeEach(() => workerChannel.subscribe(trackWorker));
afterEach(async () => {
  workerChannel.unsubscribe(trackWorker);
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

async function addSessionArtifacts(directory: string, index: number): Promise<void> {
  const hash = index.toString(16).padStart(64, "0");
  const blobDirectory = path.join(directory, "skills-prompts", "sha256", hash.slice(0, 2));
  await fs.mkdir(blobDirectory, { recursive: true });
  await fs.writeFile(path.join(directory, `session-${index}.jsonl`), Buffer.alloc(7));
  await fs.writeFile(path.join(blobDirectory, `${hash}.txt`), Buffer.alloc(11));
}

describe("physical session disk usage", () => {
  it("reports scan overload before pruning archives and recovers after queued scans drain", async () => {
    await withTestDir({ prefix: "openclaw-disk-usage-pressure-" }, async (directory) => {
      const storePath = path.join(directory, "openclaw-agent.sqlite");
      const archivePath = path.join(directory, "old.jsonl.deleted.2026-01-01T00-00-00.000Z.zst");
      await fs.writeFile(storePath, Buffer.alloc(321));
      await fs.writeFile(archivePath, Buffer.alloc(100));
      const release = createDeferredCore();
      const spy = vi
        .spyOn(WorkerTaskPool.prototype, "run")
        .mockImplementationOnce(function (this: WorkerTaskPool<unknown, unknown>, input, options) {
          spy.mockRestore();
          // Delay preparation, not the caller's result or the pool's capacity decision.
          return this.run(async () => {
            await release.promise;
            return input;
          }, options);
        });
      const accepted = Array.from({ length: 128 }, () =>
        measureSessionPhysicalDiskUsage(storePath),
      );
      let reported: unknown;
      const excess = measureSessionPhysicalDiskUsage(storePath).catch((error: unknown) => {
        reported = error;
      });
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(reported).toMatchObject({ name: "WorkerTaskError", code: "overloaded" });
        await expect(
          pruneSessionTranscriptArchivesToHighWater({ storePath, highWaterBytes: 321 }),
        ).rejects.toMatchObject({ code: "overloaded" });
        expect((await fs.stat(archivePath)).size).toBe(100);
        release.resolve();
        const usage = {
          databaseMainBytes: 321,
          databaseWalBytes: 0,
          sessionFilesBytes: 100,
          totalBytes: 421,
        };
        expect(await Promise.all(accepted)).toEqual(Array.from({ length: 128 }, () => usage));
        await expect(
          pruneSessionTranscriptArchivesToHighWater({ storePath, highWaterBytes: 321 }),
        ).resolves.toMatchObject({ removedFiles: 1, usage: { totalBytes: 321 } });
        await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(workers).toHaveLength(1);
      } finally {
        release.resolve();
        spy.mockRestore();
        await Promise.allSettled([...accepted, excess]);
      }
    });
  });

  it.each(["legacy", "sqlite", "legacy-in-agent"] as const)(
    "measures and prunes the canonical session artifacts through the %s selector",
    async (selector) => {
      await withTestDir({ prefix: "openclaw-disk-selector-" }, async (directory) => {
        const agentDir = path.join(directory, "agents", "main");
        const sessionsDir = path.join(agentDir, "sessions");
        const databasePath = path.join(agentDir, "agent", "openclaw-agent.sqlite");
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        await fs.writeFile(databasePath, Buffer.alloc(321));
        await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(654));
        await fs.writeFile(`${databasePath}-shm`, Buffer.alloc(32_768));
        await fs.writeFile(
          path.join(path.dirname(databasePath), "unrelated.txt"),
          Buffer.alloc(13),
        );
        await addSessionArtifacts(sessionsDir, 0);
        const archivePath = path.join(
          sessionsDir,
          "old.jsonl.deleted.2026-01-01T00-00-00.000Z.zst",
        );
        await fs.writeFile(archivePath, Buffer.alloc(100));
        const storePath = {
          legacy: path.join(sessionsDir, "sessions.json"),
          sqlite: databasePath,
          "legacy-in-agent": path.join(path.dirname(databasePath), "sessions.json"),
        }[selector];

        await expect(measureSessionPhysicalDiskUsage(storePath)).resolves.toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 118,
          totalBytes: 1_093,
        });
        await expect(hasRetainedSessionTranscriptArchives(storePath)).resolves.toBe(true);
        const pruned = await pruneSessionTranscriptArchivesToHighWater({
          storePath,
          highWaterBytes: 993,
        });
        expect(pruned).toMatchObject({
          removedFiles: 1,
          usage: { sessionFilesBytes: 18, totalBytes: 993 },
        });
        await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(hasRetainedSessionTranscriptArchives(storePath)).resolves.toBe(false);
      });
    },
  );

  it("propagates worker transport failure and measures successfully after recovery", async () => {
    await withTestDir({ prefix: "openclaw-disk-usage-worker-error-" }, async (directory) => {
      const storePath = path.join(directory, "openclaw-agent.sqlite");
      await fs.writeFile(storePath, Buffer.alloc(321));
      const send = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => {
        throw new Error("synthetic worker transport failure");
      });
      try {
        await expect(measureSessionPhysicalDiskUsage(storePath)).rejects.toMatchObject({
          code: "unavailable",
          message: expect.stringContaining("synthetic worker transport failure"),
        });
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBe(-1);
      } finally {
        send.mockRestore();
      }
      await expect(measureSessionPhysicalDiskUsage(storePath)).resolves.toEqual({
        databaseMainBytes: 321,
        databaseWalBytes: 0,
        sessionFilesBytes: 0,
        totalBytes: 321,
      });
      expect(workers).toHaveLength(2);
    });
  });

  it("propagates an unreadable custom-store inventory instead of reporting zero bytes", async () => {
    await withTestDir({ prefix: "openclaw-disk-usage-error-" }, async (directory) => {
      const notDirectory = path.join(directory, "not-a-directory");
      await fs.writeFile(notDirectory, "existing file");
      await expect(
        measureSessionPhysicalDiskUsage(path.join(notDirectory, "custom-store.json")),
      ).rejects.toMatchObject({
        code: "failed",
        message: expect.stringContaining("ENOTDIR"),
      });
    });
  });

  it("does not add synchronous realpath work as session artifacts grow", async () => {
    await withTestDir({ prefix: "openclaw-disk-scan-scaling-" }, async (directory) => {
      const storePath = path.join(directory, "openclaw-agent.sqlite");
      await fs.writeFile(storePath, Buffer.alloc(321));
      await fs.writeFile(`${storePath}-wal`, Buffer.alloc(654));
      await fs.writeFile(`${storePath}-shm`, Buffer.alloc(32_768));
      await addSessionArtifacts(directory, 0);
      const realpath = vi.spyOn(nodeFs, "realpathSync");
      const fixtureSyncCalls = () =>
        realpath.mock.calls.filter(
          ([candidate]) =>
            typeof candidate === "string" && candidate.startsWith(`${directory}${path.sep}`),
        ).length;
      try {
        const initial = await measureSessionPhysicalDiskUsage(storePath);
        const initialSyncCalls = fixtureSyncCalls();
        expect(initial).toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 18,
          totalBytes: 993,
        });
        for (let index = 1; index <= 32; index += 1) {
          await addSessionArtifacts(directory, index);
        }
        realpath.mockClear();

        const expanded = await measureSessionPhysicalDiskUsage(storePath);
        const expandedSyncCalls = fixtureSyncCalls();

        expect(expanded).toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 33 * 18,
          totalBytes: 975 + 33 * 18,
        });
        // Filesystem work that grows with the directory must not block the event loop.
        expect(expandedSyncCalls).toBeLessThanOrEqual(initialSyncCalls);
      } finally {
        realpath.mockRestore();
      }
    });
  });

  it.skipIf(process.platform === "win32")(
    "deduplicates SQLite aliases already counted through the sessions directory",
    async () => {
      await withTestDir({ prefix: "openclaw-disk-scan-alias-" }, async (directory) => {
        const sessionsDirectory = path.join(directory, "sessions-data");
        const aliasDirectory = path.join(directory, "sessions-alias");
        await fs.mkdir(sessionsDirectory);
        await fs.symlink(sessionsDirectory, aliasDirectory);
        const database = path.join(sessionsDirectory, "database.bin");
        const wal = path.join(sessionsDirectory, "wal.bin");
        await fs.writeFile(database, Buffer.alloc(321));
        await fs.writeFile(wal, Buffer.alloc(654));
        await fs.writeFile(path.join(sessionsDirectory, "active.jsonl"), Buffer.alloc(17));
        await fs.symlink(database, path.join(sessionsDirectory, "openclaw-agent.sqlite"));
        await fs.symlink(wal, path.join(sessionsDirectory, "openclaw-agent.sqlite-wal"));

        await addSessionArtifacts(sessionsDirectory, 0);
        await fs.writeFile(path.join(sessionsDirectory, "old.jsonl.migrated"), Buffer.alloc(4_096));

        const usage = await measureSessionPhysicalDiskUsage(
          path.join(aliasDirectory, "openclaw-agent.sqlite"),
        );

        expect(usage).toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 35,
          totalBytes: 1_010,
        });
      });
    },
  );
});
