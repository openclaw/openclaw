import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendCronRunLog,
  DEFAULT_CRON_RUN_LOG_KEEP_LINES,
  DEFAULT_CRON_RUN_LOG_MAX_BYTES,
  getPendingCronRunLogWriteCountForTests,
  readCronRunLogEntries,
  readCronRunLogEntriesPage,
  readCronRunLogEntriesPageAll,
  resolveCronRunLogPruneOptions,
  resolveCronRunLogPath,
} from "./run-log.js";

describe("cron run log", () => {
  it("resolves prune options from config with defaults", () => {
    expect(resolveCronRunLogPruneOptions()).toEqual({
      maxBytes: DEFAULT_CRON_RUN_LOG_MAX_BYTES,
      keepLines: DEFAULT_CRON_RUN_LOG_KEEP_LINES,
    });
    expect(
      resolveCronRunLogPruneOptions({
        maxBytes: "5mb",
        keepLines: 123,
      }),
    ).toEqual({
      maxBytes: 5 * 1024 * 1024,
      keepLines: 123,
    });
    expect(
      resolveCronRunLogPruneOptions({
        maxBytes: "invalid",
        keepLines: -1,
      }),
    ).toEqual({
      maxBytes: DEFAULT_CRON_RUN_LOG_MAX_BYTES,
      keepLines: DEFAULT_CRON_RUN_LOG_KEEP_LINES,
    });
  });

  async function withRunLogDir(prefix: string, run: (dir: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("resolves store path to per-job runs/<jobId>.jsonl", () => {
    const storePath = path.join(os.tmpdir(), "cron", "jobs.json");
    const p = resolveCronRunLogPath({ storePath, jobId: "job-1" });
    expect(p.endsWith(path.join(os.tmpdir(), "cron", "runs", "job-1.jsonl"))).toBe(true);
  });

  it("rejects unsafe job ids when resolving run log path", () => {
    const storePath = path.join(os.tmpdir(), "cron", "jobs.json");
    expect(() => resolveCronRunLogPath({ storePath, jobId: "../job-1" })).toThrow(
      /invalid cron run log job id/i,
    );
    expect(() => resolveCronRunLogPath({ storePath, jobId: "nested/job-1" })).toThrow(
      /invalid cron run log job id/i,
    );
    expect(() => resolveCronRunLogPath({ storePath, jobId: "..\\job-1" })).toThrow(
      /invalid cron run log job id/i,
    );
  });

  it("appends JSONL and prunes by line count", async () => {
    await withRunLogDir("openclaw-cron-log-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");

      for (let i = 0; i < 10; i++) {
        await appendCronRunLog(
          logPath,
          {
            ts: 1000 + i,
            jobId: "job-1",
            action: "finished",
            status: "ok",
            durationMs: i,
          },
          { maxBytes: 1, keepLines: 3 },
        );
      }

      const raw = await fs.readFile(logPath, "utf-8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(lines.length).toBe(3);
      const last = JSON.parse(lines[2] ?? "{}") as { ts?: number };
      expect(last.ts).toBe(1009);
    });
  });

  it.skipIf(process.platform === "win32")(
    "writes run log files with secure permissions",
    async () => {
      await withRunLogDir("openclaw-cron-log-perms-", async (dir) => {
        const logPath = path.join(dir, "runs", "job-1.jsonl");

        await appendCronRunLog(logPath, {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "ok",
        });

        const mode = (await fs.stat(logPath)).mode & 0o777;
        expect(mode).toBe(0o600);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "hardens an existing run-log directory to owner-only permissions",
    async () => {
      await withRunLogDir("openclaw-cron-log-dir-perms-", async (dir) => {
        const runDir = path.join(dir, "runs");
        const logPath = path.join(runDir, "job-1.jsonl");
        await fs.mkdir(runDir, { recursive: true, mode: 0o755 });
        await fs.chmod(runDir, 0o755);

        await appendCronRunLog(logPath, {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "ok",
        });

        const runDirMode = (await fs.stat(runDir)).mode & 0o777;
        expect(runDirMode).toBe(0o700);
      });
    },
  );

  it("reads newest entries and filters by jobId", async () => {
    await withRunLogDir("openclaw-cron-log-read-", async (dir) => {
      const logPathA = path.join(dir, "runs", "a.jsonl");
      const logPathB = path.join(dir, "runs", "b.jsonl");

      await appendCronRunLog(logPathA, {
        ts: 1,
        jobId: "a",
        action: "finished",
        status: "ok",
      });
      await appendCronRunLog(logPathB, {
        ts: 2,
        jobId: "b",
        action: "finished",
        status: "error",
        error: "nope",
        summary: "oops",
      });
      await appendCronRunLog(logPathA, {
        ts: 3,
        jobId: "a",
        action: "finished",
        status: "skipped",
        sessionId: "run-123",
        sessionKey: "agent:main:cron:a:run:run-123",
      });

      const allA = await readCronRunLogEntries(logPathA, { limit: 10 });
      expect(allA.map((e) => e.jobId)).toEqual(["a", "a"]);

      const onlyA = await readCronRunLogEntries(logPathA, {
        limit: 10,
        jobId: "a",
      });
      expect(onlyA.map((e) => e.ts)).toEqual([1, 3]);

      const lastOne = await readCronRunLogEntries(logPathA, { limit: 1 });
      expect(lastOne.map((e) => e.ts)).toEqual([3]);
      expect(lastOne[0]?.sessionId).toBe("run-123");
      expect(lastOne[0]?.sessionKey).toBe("agent:main:cron:a:run:run-123");

      const onlyB = await readCronRunLogEntries(logPathB, {
        limit: 10,
        jobId: "b",
      });
      expect(onlyB[0]?.summary).toBe("oops");

      const wrongFilter = await readCronRunLogEntries(logPathA, {
        limit: 10,
        jobId: "b",
      });
      expect(wrongFilter).toEqual([]);
    });
  });

  it("ignores invalid and non-finished lines while preserving delivery fields", async () => {
    await withRunLogDir("openclaw-cron-log-filter-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        [
          '{"bad":',
          JSON.stringify({ ts: 1, jobId: "job-1", action: "started", status: "ok" }),
          JSON.stringify({
            ts: 2,
            jobId: "job-1",
            action: "finished",
            status: "ok",
            delivered: true,
            deliveryStatus: "not-delivered",
            deliveryError: "announce failed",
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const entries = await readCronRunLogEntries(logPath, { limit: 10, jobId: "job-1" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ts).toBe(2);
      expect(entries[0]?.delivered).toBe(true);
      expect(entries[0]?.deliveryStatus).toBe("not-delivered");
      expect(entries[0]?.deliveryError).toBe("announce failed");
    });
  });

  it("reads telemetry fields", async () => {
    await withRunLogDir("openclaw-cron-log-telemetry-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");

      await appendCronRunLog(logPath, {
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "ok",
        model: "gpt-5.4",
        provider: "openai",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cache_read_tokens: 2,
          cache_write_tokens: 1,
        },
      });

      await fs.appendFile(
        logPath,
        `${JSON.stringify({
          ts: 2,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          model: " ",
          provider: "",
          usage: { input_tokens: "oops" },
        })}\n`,
        "utf-8",
      );

      const entries = await readCronRunLogEntries(logPath, { limit: 10, jobId: "job-1" });
      expect(entries[0]?.model).toBe("gpt-5.4");
      expect(entries[0]?.provider).toBe("openai");
      expect(entries[0]?.usage).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cache_read_tokens: 2,
        cache_write_tokens: 1,
      });
      expect(entries[1]?.model).toBeUndefined();
      expect(entries[1]?.provider).toBeUndefined();
      expect(entries[1]?.usage?.input_tokens).toBeUndefined();
    });
  });

  it("cleans up pending-write bookkeeping after appends complete", async () => {
    await withRunLogDir("openclaw-cron-log-pending-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-cleanup.jsonl");
      await appendCronRunLog(logPath, {
        ts: 1,
        jobId: "job-cleanup",
        action: "finished",
        status: "ok",
      });

      expect(getPendingCronRunLogWriteCountForTests()).toBe(0);
    });
  });

  it("read drains pending fire-and-forget writes", async () => {
    await withRunLogDir("openclaw-cron-log-drain-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-drain.jsonl");

      // Fire-and-forget write (simulates the `void appendCronRunLog(...)` pattern
      // in server-cron.ts). Do NOT await.
      const writePromise = appendCronRunLog(logPath, {
        ts: 42,
        jobId: "job-drain",
        action: "finished",
        status: "ok",
        summary: "drain-test",
      });
      void writePromise.catch(() => undefined);

      // Read should see the entry because it drains pending writes.
      const entries = await readCronRunLogEntries(logPath, { limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ts).toBe(42);
      expect(entries[0]?.summary).toBe("drain-test");

      // Clean up
      await writePromise.catch(() => undefined);
    });
  });

  it("readCronRunLogEntriesPage prunes oversized files before reading", async () => {
    await withRunLogDir("openclaw-cron-log-prune-read-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-prune.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // Write many lines to exceed DEFAULT_CRON_RUN_LOG_MAX_BYTES without going
      // through appendCronRunLog (simulating failed async prune)
      const lines: string[] = [];
      for (let i = 0; i < 5000; i++) {
        lines.push(
          JSON.stringify({
            ts: 1000 + i,
            jobId: "job-prune",
            action: "finished",
            status: "ok",
            summary: "x".repeat(200),
          }),
        );
      }
      await fs.writeFile(logPath, lines.join("\n") + "\n", "utf-8");

      // Verify file is larger than default max
      const sizeBefore = (await fs.stat(logPath)).size;
      expect(sizeBefore).toBeGreaterThan(DEFAULT_CRON_RUN_LOG_MAX_BYTES);

      // Reading should trigger defensive prune and not OOM
      const page = await readCronRunLogEntriesPage(logPath, {
        limit: 10,
        offset: 0,
        sortDir: "desc",
      });

      // Should still return valid entries
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.entries.length).toBeLessThanOrEqual(10);

      // File should be pruned after reading
      const sizeAfter = (await fs.stat(logPath)).size;
      expect(sizeAfter).toBeLessThanOrEqual(DEFAULT_CRON_RUN_LOG_MAX_BYTES);
    });
  });

  it("readCronRunLogEntriesPage succeeds even when prune would fail (read-only dir)", async () => {
    await withRunLogDir("openclaw-cron-log-prune-fail-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-fail.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // Write a small valid log file
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push(
          JSON.stringify({
            ts: 1000 + i,
            jobId: "job-fail",
            action: "finished",
            status: "ok",
            summary: "entry " + i,
          }),
        );
      }
      await fs.writeFile(logPath, lines.join("\n") + "\n", "utf-8");

      // Make the directory read-only so pruneIfNeeded cannot write temp files
      const runsDir = path.dirname(logPath);
      await fs.chmod(runsDir, 0o555);

      try {
        // Reading should still succeed — prune error is swallowed
        const page = await readCronRunLogEntriesPage(logPath, {
          limit: 10,
          offset: 0,
          sortDir: "desc",
        });

        expect(page.entries.length).toBe(5);
        expect(page.entries[0].summary).toBe("entry 4");
      } finally {
        // Restore permissions so cleanup works
        await fs.chmod(runsDir, 0o755);
      }
    });
  });

  it("readCronRunLogEntriesPage respects custom pruneOptions", async () => {
    await withRunLogDir("openclaw-cron-log-prune-opts-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-opts.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // Write lines totalling more than 500 bytes but less than DEFAULT_CRON_RUN_LOG_MAX_BYTES
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) {
        lines.push(
          JSON.stringify({
            ts: 1000 + i,
            jobId: "job-opts",
            action: "finished",
            status: "ok",
            summary: "entry-" + i,
          }),
        );
      }
      await fs.writeFile(logPath, lines.join("\n") + "\n", "utf-8");

      const sizeBefore = (await fs.stat(logPath)).size;
      // With default prune options this file would NOT be pruned (it is under 2 MB).
      // Pass a very small maxBytes to trigger pruning via custom pruneOptions.
      const page = await readCronRunLogEntriesPage(logPath, {
        limit: 100,
        offset: 0,
        sortDir: "desc",
        pruneOptions: { maxBytes: 500, keepLines: 10 },
      });

      // File should have been pruned to ~10 lines
      const sizeAfter = (await fs.stat(logPath)).size;
      expect(sizeAfter).toBeLessThan(sizeBefore);
      // We should still get valid entries back (the kept lines)
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.entries.length).toBeLessThanOrEqual(10);
    });
  });

  it("readCronRunLogEntriesPageAll succeeds even when prune would fail (read-only dir)", async () => {
    await withRunLogDir("openclaw-cron-log-prune-fail-all-", async (dir) => {
      const storePath = path.join(dir, "jobs.json");
      const logPath = path.join(dir, "runs", "job-fail-all.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push(
          JSON.stringify({
            ts: 2000 + i,
            jobId: "job-fail-all",
            action: "finished",
            status: "ok",
            summary: "entry-all-" + i,
          }),
        );
      }
      await fs.writeFile(logPath, lines.join("\n") + "\n", "utf-8");

      const runsDir = path.dirname(logPath);
      await fs.chmod(runsDir, 0o555);

      try {
        const page = await readCronRunLogEntriesPageAll({
          storePath,
          limit: 10,
          offset: 0,
          sortDir: "desc",
        });

        expect(page.entries.length).toBe(5);
        expect(page.entries[0].summary).toBe("entry-all-4");
      } finally {
        await fs.chmod(runsDir, 0o755);
      }
    });
  });

  it("readCronRunLogEntriesPageAll respects custom pruneOptions", async () => {
    await withRunLogDir("openclaw-cron-log-prune-opts-all-", async (dir) => {
      const storePath = path.join(dir, "jobs.json");
      const logPath = path.join(dir, "runs", "job-opts-all.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      const lines: string[] = [];
      for (let i = 0; i < 50; i++) {
        lines.push(
          JSON.stringify({
            ts: 3000 + i,
            jobId: "job-opts-all",
            action: "finished",
            status: "ok",
            summary: "entry-all-" + i,
          }),
        );
      }
      await fs.writeFile(logPath, lines.join("\n") + "\n", "utf-8");

      const sizeBefore = (await fs.stat(logPath)).size;
      const page = await readCronRunLogEntriesPageAll({
        storePath,
        limit: 100,
        offset: 0,
        sortDir: "desc",
        pruneOptions: { maxBytes: 500, keepLines: 10 },
      });

      const sizeAfter = (await fs.stat(logPath)).size;
      expect(sizeAfter).toBeLessThan(sizeBefore);
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.entries.length).toBeLessThanOrEqual(10);
    });
  });

});
