import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  encodeSessionArchiveContent,
  materializeSessionArchiveForRead,
} from "../config/sessions/archive-compression.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { writeSessionCostUsageRollupInDatabase } from "./session-cost-usage-cache.kernel.js";
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.test-support.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import {
  discoverAllSessions,
  loadCostUsageSummaryFromCache,
  loadSessionCostSummary,
  loadSessionCostSummariesFromCache,
  loadSessionUsageTimeSeries,
} from "./session-cost-usage.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function transcriptText(sessionId: string, entry: unknown): string {
  return [
    JSON.stringify({ type: "session", version: 1, id: sessionId }),
    JSON.stringify(entry),
    "",
  ].join("\n");
}

async function withUsageWorkerPreload(
  root: string,
  preload: string,
  operation: () => Promise<void>,
) {
  await closeOpenClawAgentDatabasesAsync();
  await withEnvAsync({ OPENCLAW_STATE_DIR: root, ...sqliteWorkerPreloadEnv(preload) }, async () => {
    try {
      await operation();
    } finally {
      await closeOpenClawAgentDatabasesAsync();
    }
  });
}

async function observeUsageWorkerReads(root: string, sessionFiles: string[]) {
  const preload = path.join(root, "observe-usage-reads.cjs");
  const log = path.join(root, "usage-reads.jsonl");
  await fs.writeFile(log, "");
  await fs.writeFile(
    preload,
    `const fs = require("node:fs");
const { isMainThread } = require("node:worker_threads");
if (!isMainThread) {
  const transcripts = new Set(${JSON.stringify(sessionFiles)});
  const record = (entry) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
  for (const [owner, method] of [
    [fs, "createReadStream"], [fs, "open"], [fs, "openSync"],
    [fs, "readFile"], [fs, "readFileSync"],
    [fs.promises, "open"], [fs.promises, "readFile"],
  ]) {
    const original = owner[method];
    owner[method] = function(file, ...args) {
      if (transcripts.has(String(file))) {
        record({ kind: "transcript", method, start: args[0]?.start ?? 0 });
      }
      return Reflect.apply(original, this, [file, ...args]);
    };
  }
  const { DatabaseSync } = require("node:sqlite");
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = Reflect.apply(prepare, this, [sql]);
    if (/^select\\b.*\\bfrom\\s+["\\x60]?cache_entries["\\x60]?/is.test(sql)) {
      for (const method of ["all", "get", "iterate"]) {
        const original = statement[method];
        statement[method] = function(...args) {
          if (!args.includes("session-cost-usage-rollup-v2")) {
            return Reflect.apply(original, this, args);
          }
          record({ kind: "cache" });
          const observeRow = (row) => record({
            kind: "cache-row", key: row.key,
            valueBytes: typeof row.value_json === "string"
              ? Buffer.byteLength(row.value_json)
              : ArrayBuffer.isView(row.value_json) ? row.value_json.byteLength : 0,
          });
          const result = Reflect.apply(original, this, args);
          if (method === "iterate") {
            return (function* () {
              for (const row of result) {
                observeRow(row);
                yield row;
              }
            })();
          }
          if (method === "all") {
            for (const row of result) observeRow(row);
          } else if (result) {
            observeRow(result);
          }
          return result;
        };
      }
    }
    return statement;
  };
  require("node:module").syncBuiltinESMExports();
}
`,
  );
  return {
    run: (operation: () => Promise<void>) => withUsageWorkerPreload(root, preload, operation),
    clear: () => fs.writeFile(log, ""),
    read: async () =>
      (await fs.readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as
              | { kind: "cache" }
              | { kind: "cache-row"; key: string; valueBytes: number }
              | { kind: "transcript"; method: string; start: number },
        ),
  };
}

describe("session cost usage worker I/O", () => {
  it.each(["zstd", "plain"] as const)(
    "inventories %s archives without reading payloads and materializes only for a summary",
    async (encoding) => {
      const root = tempDirs.make("openclaw-usage-worker-metadata-");
      const sessionsDir = path.join(root, "agents", "main", "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionId = `metadata-${encoding}`;
      const content = transcriptText(sessionId, {
        type: "message",
        message: { role: "user", content: "synthetic archived message" },
      });
      const encoded =
        encoding === "plain"
          ? { suffix: "", bytes: Buffer.from(content) }
          : encodeSessionArchiveContent(content);
      const archive = path.join(
        sessionsDir,
        `${sessionId}.jsonl.reset.2026-02-05T12-00-00.000Z${encoded.suffix}`,
      );
      await fs.writeFile(archive, encoded.bytes);
      const { mtimeMs } = await fs.stat(archive);
      const reads = await observeUsageWorkerReads(root, [archive]);
      await reads.run(async () => {
        expect(await discoverAllSessions({ agentId: "main" })).toEqual([
          { sessionId, sessionFile: archive, mtime: mtimeMs },
        ]);
        expect(
          await runUsageCostWorker(
            prepareUsageCostWorker({ agentId: "main", sessionFiles: [archive] }),
            { kind: "inventory", sessionFiles: [archive] },
          ),
        ).toEqual({
          kind: "inventory",
          files: [{ kind: "jsonl", sourcePath: archive, sessionId, mtimeMs }],
        });
        expect((await reads.read()).filter((entry) => entry.kind === "transcript")).toEqual([]);
        expect(
          await loadSessionCostSummary({ agentId: "main", sessionFile: archive }),
        ).not.toBeNull();
        expect((await reads.read()).some((entry) => entry.kind === "transcript")).toBe(true);
      });
    },
  );

  it("joins compressed archive materialization before settling summary cancellation", async () => {
    const root = tempDirs.make("openclaw-usage-worker-native-archive-");
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const encoded = encodeSessionArchiveContent(
      transcriptText("native-archive", {
        type: "message",
        message: { role: "user", content: "synthetic archived message" },
      }),
    );
    expect(encoded.suffix).toBe(".zst");
    const archive = path.join(
      sessionsDir,
      `native-archive.jsonl.reset.2026-02-05T12-00-00.000Z${encoded.suffix}`,
    );
    await fs.writeFile(archive, encoded.bytes);
    const entered = path.join(root, "native-entered");
    const released = path.join(root, "native-release");
    const completed = path.join(root, "native-completed");
    const preload = path.join(root, "hold-archive-native.cjs");
    await fs.writeFile(
      preload,
      `const fs = require("node:fs");
const zlib = require("node:zlib");
const { isMainThread, threadId } = require("node:worker_threads");
if (!isMainThread) {
  const compressed = Buffer.from(${JSON.stringify(encoded.bytes.toString("base64"))}, "base64");
  const decompress = zlib.zstdDecompressSync;
  zlib.zstdDecompressSync = function(bytes, ...args) {
    if (!Buffer.from(bytes).equals(compressed)) return Reflect.apply(decompress, this, [bytes, ...args]);
    fs.writeFileSync(${JSON.stringify(entered)}, String(threadId));
    const deadline = Date.now() + 10000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(${JSON.stringify(released)})) {
      if (Date.now() >= deadline) throw new Error("Archive native gate timed out");
      Atomics.wait(pause, 0, 0, 10);
    }
    const result = Reflect.apply(decompress, this, [bytes, ...args]);
    fs.writeFileSync(${JSON.stringify(completed)}, "complete");
    return result;
  };
  require("node:module").syncBuiltinESMExports();
}
`,
    );
    try {
      await withUsageWorkerPreload(root, preload, async () => {
        const posts = vi.spyOn(Worker.prototype, "postMessage");
        const terminate = vi.spyOn(Worker.prototype, "terminate");
        const scope = new AsyncWorkScope();
        const reason = new Error("summary owner closed");
        let summarySettled = false;
        let drainSettled = false;
        const summary = scope.track(() =>
          loadSessionCostSummary({ agentId: "main", sessionFile: archive }),
        );
        const outcome = Promise.allSettled([summary]).then(([result]) => {
          summarySettled = true;
          return result;
        });
        try {
          await vi.waitFor(
            async () => expect(Number(await fs.readFile(entered, "utf8"))).toBeGreaterThan(0),
            {
              interval: 5,
              timeout: 10_000,
            },
          );
          const dispatch = posts.mock.calls.findIndex(
            ([message]) =>
              isRecord(message) &&
              isRecord(message.input) &&
              message.input.kind === "usage-cost" &&
              isRecord(message.input.operation) &&
              message.input.operation.kind === "refresh",
          );
          const worker = posts.mock.contexts[dispatch];
          if (!(worker instanceof Worker)) {
            throw new Error("Expected the usage refresh worker");
          }
          expect(worker.threadId).toBe(Number(await fs.readFile(entered, "utf8")));
          scope.beginClose(reason);
          const draining = scope.drain().then(() => {
            drainSettled = true;
          });
          await setImmediate();
          const termination = terminate.mock.contexts.findIndex((owner) => owner === worker);
          if (termination >= 0) {
            await terminate.mock.results[termination]?.value;
          }
          expect(summarySettled).toBe(false);
          expect(drainSettled).toBe(false);
          expect(worker.threadId).toBeGreaterThan(0);
          expect(termination).toBe(-1);
          await fs.writeFile(released, "release");
          expect(await outcome).toMatchObject({ status: "rejected" });
          await draining;
          expect(await fs.readFile(completed, "utf8")).toBe("complete");
          expect(worker.threadId).toBe(-1);
          expect(scope.hasPendingWork).toBe(false);
        } finally {
          try {
            await fs.writeFile(released, "release");
          } finally {
            scope.beginClose(reason);
            try {
              await outcome;
              await scope.drain();
            } finally {
              terminate.mockRestore();
              posts.mockRestore();
            }
          }
        }
      });
    } finally {
      await fs.rm(archive, { force: true });
      expect(() => materializeSessionArchiveForRead(archive)).toThrow(/ENOENT/);
    }
  }, 20_000);

  it("increments from the durable byte offset and rebuilds after truncation", async () => {
    const root = tempDirs.make("openclaw-usage-worker-incremental-");
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "sess-incremental.jsonl");
    const assistantEntry = (timestamp: string, totalTokens: number, content = "") =>
      JSON.stringify({
        type: "message",
        timestamp,
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.5",
          content,
          usage: {
            input: totalTokens,
            output: 0,
            totalTokens,
            cost: { total: totalTokens / 1000 },
          },
        },
      });
    await fs.writeFile(
      sessionFile,
      [
        assistantEntry("2026-02-05T12:00:00.000Z", 10, "🦞".repeat(32 * 1024)),
        assistantEntry("2026-02-05T12:01:00.000Z", 20),
      ].join("\n"),
      "utf-8",
    );

    const probe = await observeUsageWorkerReads(root, [sessionFile]);
    await probe.run(async () => {
      const initial = requireValue(
        await loadSessionCostSummary({ sessionFile, agentId: "main" }),
        "expected initial summary",
      );
      const fullParse = requireValue(
        await loadSessionUsageTimeSeries({ sessionFile, agentId: "main", maxPoints: 1_000 }),
        "expected full parse reference",
      );
      expect(initial.totalTokens).toBe(
        fullParse.points.reduce((total, point) => total + point.totalTokens, 0),
      );

      const initialRow = requireValue(
        readSessionCostUsageRollupRows("main").find((row) => row.key === sessionFile),
        "expected initial rollup",
      );
      const initialEntry = JSON.parse(initialRow.valueJson) as {
        checkpoint: { kind: "jsonl"; parsedOffset: number };
        parsedRecords: number;
      };
      expect(initialEntry.checkpoint.parsedOffset).toBe((await fs.stat(sessionFile)).size);
      expect(initialEntry.parsedRecords).toBe(2);

      await probe.clear();
      await fs.appendFile(
        sessionFile,
        `\n${assistantEntry("2026-02-05T12:02:00.000Z", 5)}`,
        "utf-8",
      );
      const appended = await loadSessionCostSummary({ sessionFile, agentId: "main" });
      expect(appended?.totalTokens).toBe(35);
      expect(
        (await probe.read()).flatMap((entry) =>
          entry.kind === "transcript" && entry.method === "createReadStream" ? [entry.start] : [],
        ),
      ).toEqual([initialEntry.checkpoint.parsedOffset]);

      const completeSize = (await fs.stat(sessionFile)).size;
      await fs.appendFile(sessionFile, '\n{"type":"message","timestamp":"2026-02-05', "utf-8");
      expect((await loadSessionCostSummary({ sessionFile, agentId: "main" }))?.totalTokens).toBe(
        35,
      );
      const partialRow = requireValue(
        readSessionCostUsageRollupRows("main").find((row) => row.key === sessionFile),
        "expected partial-line rollup",
      );
      const partialEntry = JSON.parse(partialRow.valueJson) as {
        checkpoint: { kind: "jsonl"; parsedOffset: number };
      };
      expect(partialEntry.checkpoint.parsedOffset).toBe(completeSize + 1);
      await fs.appendFile(
        sessionFile,
        'T12:03:00.000Z","message":{"role":"assistant","usage":{"input":7,"output":0,"totalTokens":7,"cost":{"total":0.007}}}}',
        "utf-8",
      );
      expect((await loadSessionCostSummary({ sessionFile, agentId: "main" }))?.totalTokens).toBe(
        42,
      );

      await probe.clear();
      await fs.writeFile(sessionFile, assistantEntry("2026-02-05T13:00:00.000Z", 11), "utf-8");
      const rebuilt = await loadSessionCostSummary({ sessionFile, agentId: "main" });
      expect(rebuilt?.totalTokens).toBe(11);
      expect(
        (await probe.read()).flatMap((entry) =>
          entry.kind === "transcript" && entry.method === "createReadStream" ? [entry.start] : [],
        ),
      ).toEqual([0]);
      const rebuiltRow = requireValue(
        readSessionCostUsageRollupRows("main").find((row) => row.key === sessionFile),
        "expected rebuilt rollup",
      );
      const rebuiltEntry = JSON.parse(rebuiltRow.valueJson) as { parsedRecords: number };
      expect(rebuiltEntry.parsedRecords).toBe(1);
    });
  });

  it("loads multiple session summaries from one durable cache snapshot", async () => {
    const root = tempDirs.make("openclaw-usage-worker-selection-");
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessions = await Promise.all(
      ["sess-a", "sess-b"].map(async (sessionId, index) => {
        const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
        await fs.writeFile(
          sessionFile,
          transcriptText(sessionId, {
            type: "message",
            timestamp: `2026-02-05T23:0${index}:00.000Z`,
            message: {
              role: "assistant",
              provider: "custom",
              model: "unpriced-batch",
              usage: { input: index + 1, output: 0, totalTokens: index + 1 },
            },
          }),
          "utf-8",
        );
        return { sessionId, sessionFile };
      }),
    );

    const probe = await observeUsageWorkerReads(
      root,
      sessions.map((session) => session.sessionFile),
    );
    await probe.run(async () => {
      const warmed = await loadCostUsageSummaryFromCache({
        agentId: "main",
        startMs: Date.UTC(2026, 1, 5),
        endMs: Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1,
        refreshMode: "sync-when-empty",
      });
      expect(warmed.cacheStatus?.status).toBe("fresh");
      expect(warmed.totals.missingCostByModel).toEqual({ "custom/unpriced-batch": 2 });

      await loadSessionCostSummariesFromCache({
        sessions,
        agentId: "main",
      });
      await vi.waitFor(
        async () => {
          const cached = await loadSessionCostSummariesFromCache({
            sessions,
            agentId: "main",
            requestRefresh: false,
          });
          expect(cached.cacheStatus.status).toBe("fresh");
          expect(cached.summaries.map((summary) => summary?.missingCostByModel)).toEqual([
            { "custom/unpriced-batch": 1 },
            { "custom/unpriced-batch": 1 },
          ]);
        },
        { interval: 10, timeout: 2_000 },
      );

      const selectedRow = requireValue(
        readSessionCostUsageRollupRows("main")[0],
        "expected a selected rollup",
      );
      const selectedEntry = JSON.parse(selectedRow.valueJson) as Record<string, unknown>;
      const unrelatedValue = new TextEncoder().encode(
        JSON.stringify({ ...selectedEntry, syntheticPadding: "雪".repeat(400_000) }),
      );
      expect(
        runOpenClawAgentWriteTransaction(
          ({ db }) =>
            writeSessionCostUsageRollupInDatabase(db, {
              rollupId: path.join(sessionsDir, "unrequested.jsonl"),
              previousValueJson: null,
              valueJson: unrelatedValue,
              updatedAt: selectedRow.updatedAt,
            }),
          { agentId: "main" },
          { operationLabel: "session-cost-usage.rollup.write" },
        ),
      ).toBe(true);

      await probe.clear();
      const result = await loadSessionCostSummariesFromCache({
        sessions,
        agentId: "main",
        startMs: Date.UTC(2026, 1, 5),
        endMs: Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1,
        dayBucket: { mode: "time-zone", timeZone: "Europe/Vienna" },
        requestRefresh: false,
      });

      expect(result.cacheStatus.status).toBe("fresh");
      expect(result.summaries.map((summary) => summary?.totalTokens)).toEqual([1, 2]);
      expect(result.summaries.map((summary) => summary?.activityDates)).toEqual([
        ["2026-02-06"],
        ["2026-02-06"],
      ]);
      const reads = await probe.read();
      expect(reads.filter((entry) => entry.kind === "cache")).toHaveLength(1);
      expect(reads.filter((entry) => entry.kind === "transcript")).toEqual([]);
      const cacheRows = reads.filter((entry) => entry.kind === "cache-row");
      const returnedBytes = cacheRows.reduce((total, row) => total + row.valueBytes, 0);
      expect(returnedBytes, "selected cache JSON bytes").toBeGreaterThan(0);
      expect(returnedBytes, "selected cache JSON bytes").toBeLessThan(16 * 1_024);
      expect(cacheRows.map((row) => row.key).toSorted()).toEqual(
        sessions.map((session) => session.sessionFile).toSorted(),
      );
    });
  });
});
