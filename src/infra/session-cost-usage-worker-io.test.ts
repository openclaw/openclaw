import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { setEnvironmentData, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptWorkerClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  encodeSessionArchiveContent,
  materializeSessionArchiveForRead,
} from "../config/sessions/archive-compression.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveSqliteTranscriptScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { writeSessionCostUsageRollupInDatabase } from "./session-cost-usage-cache.kernel.js";
import { prepareSessionCostUsageRefreshLock } from "./session-cost-usage-cache.sqlite.js";
import {
  readSessionCostUsageRollupRows,
  readSessionCostUsageRollupEntry,
} from "./session-cost-usage-cache.test-support.js";
import { partitionUsageCostRollup } from "./session-cost-usage-partitions.js";
import { encodeUsageCostRollup } from "./session-cost-usage-rollup-codec.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadSessionCostSummary,
  loadSessionCostSummariesFromCache,
  loadSessionUsageTimeSeries,
} from "./session-cost-usage.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

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
  await closeStateDatabaseForTest();
  await withEnvAsync({ OPENCLAW_STATE_DIR: root, ...sqliteWorkerPreloadEnv(preload) }, async () => {
    setRuntimeConfigSnapshot({});
    try {
      await operation();
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      await closeStateDatabaseForTest();
      clearRuntimeConfigSnapshot();
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
  const zlib = require("node:zlib");
  const decompress = zlib.zstdDecompressSync;
  if (decompress) {
    zlib.zstdDecompressSync = function(data, options) {
      record({ kind: "decompress", outputLimit: options?.maxOutputLength ?? 0 });
      return Reflect.apply(decompress, this, [data, options]);
    };
  }
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = Reflect.apply(prepare, this, [sql]);
    if (/^select\\b.*\\bfrom\\s+["\\x60]?transcript_events["\\x60]?/is.test(sql)) {
      for (const method of ["all", "get", "iterate"]) {
        const original = statement[method];
        statement[method] = function(...args) {
          record({ kind: "transcript-stats" });
          return Reflect.apply(original, this, args);
        };
      }
    }
    if (sql.includes('as "is_cold"') && sql.includes('"transcript_rewrite_watermarks"')) {
      for (const method of ["all", "get", "iterate"]) {
        const original = statement[method];
        statement[method] = function(...args) {
          record({ kind: "hot-watermark" });
          return Reflect.apply(original, this, args);
        };
      }
    }
    if (/^select\\b.*\\bfrom\\s+["\\x60]?cache_entries["\\x60]?/is.test(sql)) {
      for (const method of ["all", "get", "iterate"]) {
        const original = statement[method];
        statement[method] = function(...args) {
          if (args.includes("session-cost-usage-projection-v1")) {
            record({ kind: "partitions" });
          }
          const rollup = args.includes("session-cost-usage-rollup-v3");
          if (!rollup && !args.includes("session-cost-usage-projection-v1")) {
            return Reflect.apply(original, this, args);
          }
          if (rollup) record({ kind: "cache" });
          const observeRow = (row) => record({
            kind: rollup ? "cache-row" : "partition-row", key: row.key,
            blobBytes: row.blob?.byteLength ?? 0,
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
              | { kind: "transcript-stats" }
              | { kind: "hot-watermark" }
              | { kind: "cache" }
              | { kind: "partitions" }
              | { kind: "decompress"; outputLimit: number }
              | {
                  kind: "cache-row" | "partition-row";
                  key: string;
                  valueBytes: number;
                  blobBytes: number;
                }
              | { kind: "transcript"; method: string; start: number },
        ),
  };
}

describe("session cost usage worker I/O", () => {
  it("reuses discovered and receipt-covered usage inputs across append, rewrite, and rollup replacement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const probe = await observeUsageWorkerReads(state.stateDir, []);
      await probe.run(async () => {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const scope = resolveSqliteTranscriptScope({
          agentId: "main",
          sessionKey: "agent:main:usage-rewrite",
          sessionId: "usage-rewrite",
          storePath: database.path,
        });
        const message = (id: string, parentId: string | null, tokens: number) => ({
          type: "message",
          id,
          parentId,
          timestamp: "2026-09-18T00:00:00Z",
          message: {
            role: "assistant",
            usage: { input: tokens, output: 0, totalTokens: tokens, cost: { total: tokens } },
          },
        });
        const first = message("first", null, 1);
        runOpenClawAgentWriteTransaction(
          (owner) => {
            writeSessionEntry(owner, scope.sessionKey, {
              sessionId: scope.sessionId,
              updatedAt: 1,
            });
            appendTranscriptEventsInTransaction(
              owner,
              scope,
              [
                { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId },
                first,
                message("second", "first", 2),
              ],
              {
                scheduleProjectionReconcile: false,
              },
            );
          },
          { agentId: scope.agentId, path: database.path },
        );
        const sessionFile = formatSqliteSessionFileMarker({
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          storePath: database.path,
        });
        const refresh = () =>
          refreshCostUsageCacheForAgent({ agentId: "main", sessionFiles: [sessionFile] });
        const cached = () =>
          loadSessionCostSummariesFromCache({
            agentId: "main",
            sessions: [{ sessionFile }],
            requestRefresh: false,
          });
        await refresh();
        expect(await cached()).toMatchObject({ summaries: [{ totalTokens: 3 }] });
        let discovered = await discoverAllSessions({ agentId: "main" });
        const expectDiscovered = async (
          sessions: Awaited<ReturnType<typeof discoverAllSessions>>,
          summaries: Array<{ totalTokens: number } | null>,
          status: "fresh" | "partial" | "stale",
        ) => {
          await probe.clear();
          expect(
            await loadSessionCostSummariesFromCache({
              agentId: "main",
              sessions,
              requestRefresh: false,
            }),
          ).toMatchObject({ summaries, cacheStatus: { status } });
          expect((await probe.read()).filter((entry) => entry.kind === "transcript-stats")).toEqual(
            [],
          );
        };
        await expectDiscovered(discovered, [{ totalTokens: 3 }], "fresh");
        await probe.clear();
        await refresh();
        expect(
          (await probe.read()).filter(
            (entry) => entry.kind === "transcript-stats" || entry.kind === "cache",
          ),
        ).toEqual([]);
        const generation = runOpenClawAgentWriteTransaction(
          (owner) => {
            const rewritten = rewriteSqliteTranscriptEventRowsInTransaction(owner, scope, [
              {
                seq: 1,
                expectedEventJson: JSON.stringify(first),
                event: message("first", null, 8),
              },
            ]);
            appendTranscriptEventsInTransaction(owner, scope, [message("third", "second", 4)], {
              scheduleProjectionReconcile: false,
            });
            return rewritten;
          },
          { agentId: scope.agentId, path: database.path },
        );
        expect(generation).toEqual(expect.any(String));
        const rewrittenDiscovery = await discoverAllSessions({ agentId: "main" });
        await expectDiscovered(rewrittenDiscovery, [null], "stale");
        await probe.clear();
        await refresh();
        expect(await cached()).toMatchObject({
          summaries: [{ totalTokens: 14, totalCost: 14 }],
          cacheStatus: { status: "fresh" },
        });
        const row = requireValue(
          readSessionCostUsageRollupRows("main").find((entry) => entry.key === sessionFile),
          "expected rewritten SQLite usage rollup",
        );
        expect(JSON.parse(row.valueJson)).toMatchObject({
          checkpoint: { kind: "sqlite", generation, maxSeq: 3, eventCount: 4 },
        });
        const reads = await probe.read();
        expect(reads.some((entry) => entry.kind === "transcript-stats")).toBe(true);
        expect(reads.filter((entry) => entry.kind === "hot-watermark")).toEqual([]);
        await expectDiscovered(discovered, [null], "partial");
        discovered = rewrittenDiscovery;
        runOpenClawAgentWriteTransaction(
          (owner) =>
            appendTranscriptEventsInTransaction(owner, scope, [message("fourth", "third", 5)], {
              scheduleProjectionReconcile: false,
            }),
          { agentId: scope.agentId, path: database.path },
        );
        await probe.clear();
        await refresh();
        const appendReads = await probe.read();
        expect(appendReads.filter((entry) => entry.kind === "cache")).toEqual([]);
        expect(await cached()).toMatchObject({ summaries: [{ totalTokens: 19 }] });
        await expectDiscovered(discovered, [{ totalTokens: 19 }], "fresh");

        // Another in-process writer replaces the derived row. Its receipt must
        // invalidate the retained rollup, while unchanged transcript stats survive.
        runOpenClawAgentWriteTransaction(
          (owner) =>
            writeSessionCostUsageRollupInDatabase(owner.db, {
              rollupId: sessionFile,
              valueJson: new TextEncoder().encode("{}"),
              blob: null,
              updatedAt: Date.now(),
            }),
          { agentId: scope.agentId, path: database.path },
        );
        await refresh();
        expect(await cached()).toMatchObject({ summaries: [{ totalTokens: 19 }] });
      });
    });
  });

  it("returns uncached SQLite sessions as pending without reading transcript statistics", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionFile = formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "not-yet-projected",
        storePath: database.path,
      });
      const probe = await observeUsageWorkerReads(state.stateDir, []);
      await probe.run(async () => {
        expect(
          await loadSessionCostSummariesFromCache({
            agentId: "main",
            sessions: [{ sessionFile }],
            requestRefresh: false,
          }),
        ).toMatchObject({
          summaries: [null],
          cacheStatus: { status: "stale", cachedFiles: 0, pendingFiles: 1, staleFiles: 1 },
        });
        expect((await probe.read()).filter((entry) => entry.kind === "transcript-stats")).toEqual(
          [],
        );
      });
    });
  });

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

  it("joins compressed archive materialization before settling summary cancellation", async ({
    signal,
  }) => {
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
    const release = new Int32Array(new SharedArrayBuffer(4));
    setEnvironmentData(entered, release.buffer);
    const releaseNative = () => {
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
    };
    const completed = path.join(root, "native-completed");
    const preload = path.join(root, "hold-archive-native.cjs");
    await fs.writeFile(
      preload,
      `const fs = require("node:fs");
const zlib = require("node:zlib");
const { getEnvironmentData, isMainThread, threadId } = require("node:worker_threads");
${fixtureReceiptWorkerClientSource(receipts.broadcastName).replace(
  'import { BroadcastChannel as FixtureReceiptBroadcastChannel } from "node:worker_threads";',
  'const { BroadcastChannel: FixtureReceiptBroadcastChannel } = require("node:worker_threads");',
)}
if (!isMainThread) {
  const compressed = Buffer.from(${JSON.stringify(encoded.bytes.toString("base64"))}, "base64");
  const decompress = zlib.zstdDecompressSync;
  zlib.zstdDecompressSync = function(bytes, ...args) {
    if (!Buffer.from(bytes).equals(compressed)) return Reflect.apply(decompress, this, [bytes, ...args]);
    fs.writeFileSync(${JSON.stringify(entered)}, String(threadId));
    sendReceipt(${JSON.stringify(entered)}, "entered");
    const release = new Int32Array(getEnvironmentData(${JSON.stringify(entered)}));
    while (Atomics.load(release, 0) === 0) Atomics.wait(release, 0, 0);
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
          // The marker precedes both the receipt and any summary settlement.
          await withinTest(
            Promise.race([
              receipts.waitFor(entered, "entered"),
              outcome.then(async () => {
                expect(Number(await fs.readFile(entered, "utf8"))).toBeGreaterThan(0);
              }),
            ]),
            signal,
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
          releaseNative();
          expect(await outcome).toMatchObject({ status: "rejected" });
          await draining;
          expect(await fs.readFile(completed, "utf8")).toBe("complete");
          expect(worker.threadId).toBe(-1);
          expect(scope.hasPendingWork).toBe(false);
        } finally {
          try {
            releaseNative();
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
      setEnvironmentData(entered, undefined);
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
      const warmed = await loadCostUsageSummary({
        agentId: "main",
        startMs: Date.UTC(2026, 1, 5),
        endMs: Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1,
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
              valueJson: unrelatedValue,
              blob: null,
              updatedAt: selectedRow.updatedAt,
            }),
          { agentId: "main" },
          { operationLabel: "session-cost-usage.rollup.write" },
        ),
      ).toBe(true);

      await probe.clear();
      await refreshCostUsageCacheForAgent({
        agentId: "main",
        sessionFiles: [sessions[0]!.sessionFile],
      });
      expect(
        (await probe.read()).flatMap((entry) => (entry.kind === "cache-row" ? [entry.key] : [])),
      ).toEqual([sessions[0]!.sessionFile]);
      expect(
        readSessionCostUsageRollupRows("main").some((row) => row.key.endsWith("unrequested.jsonl")),
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
      expect(
        reads.filter((entry) => entry.kind === "cache" || entry.kind === "partitions").length,
        "selected report cache queries must amortize metadata, bodies, and partitions",
      ).toBeLessThanOrEqual(sessions.length);
      expect(reads.filter((entry) => entry.kind === "transcript")).toEqual([]);
      const cacheRows = reads.flatMap((entry) => (entry.kind === "cache-row" ? [entry] : []));
      const returnedBytes = cacheRows.reduce((total, row) => total + row.valueBytes, 0);
      expect(returnedBytes, "selected cache JSON bytes").toBeGreaterThan(0);
      expect(returnedBytes, "selected cache JSON bytes").toBeLessThan(16 * 1_024);
      const comparePaths = (a: string, b: string) => a.localeCompare(b);
      expect(
        cacheRows
          .filter((row) => row.valueBytes > 0)
          .map((row) => row.key)
          .toSorted(comparePaths),
      ).toEqual(sessions.map((session) => session.sessionFile).toSorted(comparePaths));
    });
  });
});

it("uses committed aggregates for fractional model costs without replaying transcripts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config = {};
    const agentId = "usage-model-rounding";
    const sessionFile = state.path("usage-model-rounding.jsonl");
    const records = [
      { timestamp: "2026-09-18T00:00:00Z", costs: [0.1, 0.9] },
      { timestamp: "2026-09-18T00:15:00Z", costs: [0.2, 0.8] },
      { timestamp: "2026-09-18T00:16:00Z", costs: [0.3, 0.7] },
    ].flatMap(({ timestamp, costs }) =>
      costs.map((cost, index) =>
        JSON.stringify({
          type: "message",
          timestamp,
          message: {
            role: "assistant",
            provider: "test",
            model: `model-${index}`,
            usage: { input: 1, output: 0, totalTokens: 1, cost: { total: cost } },
          },
        }),
      ),
    );
    await fs.writeFile(sessionFile, records.join("\n") + "\n");
    await refreshCostUsageCacheForAgent({ config, agentId, sessionFiles: [sessionFile] });
    const request = {
      config,
      agentId,
      sessions: [{ sessionFile }],
      requestRefresh: false,
      startMs: Date.UTC(2026, 8, 18),
      endMs: Date.UTC(2026, 8, 18, 0, 29, 59, 999),
      dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 0 },
    };
    const probe = await observeUsageWorkerReads(state.stateDir, [sessionFile]);
    await probe.run(async () => {
      const cached = await loadSessionCostSummariesFromCache(request);
      expect(cached.cacheStatus.status).toBe("fresh");
      expect(cached.summaries[0]?.totalTokens).toBe(6);
      expect(cached.summaries[0]?.totalCost).toBe(3);
      const model = cached.summaries[0]?.modelUsage?.find((entry) => entry.model === "model-0");
      expect(model?.totals.totalCost).toBeCloseTo(0.6, 12);
      expect((await probe.read()).filter((entry) => entry.kind === "transcript")).toEqual([]);
    });
  });
});

it("defers oversized exact ranges without treating valid aggregates as corrupt", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-replay-budget";
    const sessionFile = state.path("usage-replay-budget.jsonl");
    const timestamp = Date.UTC(2026, 8, 18, 0, 1);
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        timestamp: new Date(timestamp).toISOString(),
        message: {
          role: "assistant",
          content: "x".repeat(16 * 1024 * 1024),
          usage: { input: 7, output: 0, totalTokens: 7, cost: { total: 0.1 } },
        },
      }) + "\n",
    );
    await refreshCostUsageCacheForAgent({ config: {}, agentId, sessionFiles: [sessionFile] });
    const probe = await observeUsageWorkerReads(state.stateDir, [sessionFile]);
    await probe.run(async () => {
      const prepared = prepareUsageCostWorker({ agentId, sessionFiles: [sessionFile] });
      const rows = readSessionCostUsageRollupRows(agentId);
      const pricingFingerprint = JSON.parse(rows[0]!.valueJson).pricingFingerprint as string;
      const exact = await runUsageCostWorker(prepared, {
        kind: "sessions",
        sessions: [{ sessionFile }],
        pricingFingerprint,
        startMs: timestamp,
        endMs: timestamp + 1,
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      });
      expect(exact).toMatchObject({
        kind: "sessions",
        summaries: [null],
        cacheStatus: { status: "partial", cachedFiles: 0, pendingFiles: 1, staleFiles: 0 },
        staleSessionFiles: [],
        invalidRows: [],
      });
      const computing = await loadSessionCostSummariesFromCache({
        agentId,
        sessions: [{ sessionFile }],
        startMs: timestamp,
        endMs: timestamp + 1,
      });
      expect(computing).toMatchObject({
        summaries: [null],
        cacheStatus: { status: "partial", pendingFiles: 1, staleFiles: 0 },
      });
      expect((await probe.read()).filter((entry) => entry.kind === "transcript")).toEqual([]);
      const aligned = await loadSessionCostSummariesFromCache({
        agentId,
        sessions: [{ sessionFile }],
        requestRefresh: false,
      });
      expect(aligned).toMatchObject({
        summaries: [{ totalTokens: 7 }],
        cacheStatus: { status: "fresh" },
      });
    });
  });
});

it("bounds stored and compressed cache payloads while keeping other sessions available", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-cache-payload-budget";
    const sessions = await Promise.all(
      ["large", "small"].map(async (sessionId) => {
        const sessionFile = state.path(`agents/${agentId}/sessions/${sessionId}.jsonl`);
        await fs.mkdir(path.dirname(sessionFile), { recursive: true });
        await fs.writeFile(
          sessionFile,
          transcriptText(sessionId, {
            type: "message",
            timestamp: "2026-09-18T00:00:00Z",
            message: { role: "assistant", usage: { input: 7, output: 0, totalTokens: 7 } },
          }),
        );
        return { sessionId, sessionFile };
      }),
    );
    await refreshCostUsageCacheForAgent({
      config: {},
      agentId,
      sessionFiles: sessions.map((session) => session.sessionFile),
    });
    const row = requireValue(
      readSessionCostUsageRollupRows(agentId).find(
        (candidate) => candidate.key === sessions[0]!.sessionFile,
      ),
      "expected large-session checkpoint",
    );
    const pricingFingerprint = JSON.parse(row.valueJson).pricingFingerprint as string;
    const original = requireValue(
      readSessionCostUsageRollupEntry(row, agentId),
      "expected valid checkpoint",
    );
    const probe = await observeUsageWorkerReads(
      state.stateDir,
      sessions.map((session) => session.sessionFile),
    );
    for (const variant of ["stored body", "compressed body", "compressed partition"] as const) {
      const entry = structuredClone(original);
      const tools = [
        {
          name:
            "synthetic-tool-" +
            "x".repeat(variant === "stored body" ? 2 * 1024 * 1024 : 35 * 1024 * 1024),
          count: 1,
        },
      ];
      if (variant === "compressed partition") {
        entry.rollup.buckets[String(Date.UTC(2026, 8, 18))] = {
          ...entry.rollup.untimestamped,
          tools,
          timestampMs: Date.UTC(2026, 8, 18),
          latency: { centroids: [], count: 0, max: 0, sum: 0 },
        };
      } else {
        entry.rollup.untimestamped.tools = tools;
      }
      const encoded =
        variant === "compressed partition"
          ? partitionUsageCostRollup(entry)
          : { ...encodeUsageCostRollup(entry), partitions: [] };
      if (variant === "stored body") {
        encoded.blob = Uint8Array.from(Buffer.from(JSON.stringify(entry.rollup)));
        const envelope = JSON.parse(encoded.valueJson);
        envelope.body.encoding = "identity";
        envelope.body.storedBytes = encoded.blob.byteLength;
        encoded.valueJson = JSON.stringify(envelope);
      }
      const lock = prepareSessionCostUsageRefreshLock(agentId);
      try {
        expect(await lock.acquire()).toBe(true);
        expect(
          await lock.writeRollup({
            rollupId: row.key,
            valueJson: new TextEncoder().encode(encoded.valueJson),
            blob: encoded.blob,
            partitions: encoded.partitions,
            replacePartitions: true,
            updatedAt: row.updatedAt,
          }),
        ).toBe(true);
      } finally {
        await lock.release();
      }
      await probe.clear();
      await probe.run(async () => {
        const prepared = prepareUsageCostWorker({
          agentId,
          sessionFiles: sessions.map((session) => session.sessionFile),
        });
        const result = await runUsageCostWorker(prepared, {
          kind: "sessions",
          sessions,
          pricingFingerprint,
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        });
        expect(result, variant).toMatchObject({
          kind: "sessions",
          summaries: [null, { totalTokens: 7 }],
          cacheStatus: { status: "partial", cachedFiles: 1, pendingFiles: 1, staleFiles: 0 },
          staleSessionFiles: [],
          invalidRows: [],
        });
        const reads = await probe.read();
        expect(reads.filter((read) => read.kind === "transcript")).toEqual([]);
        expect(
          reads
            .filter((read) => read.kind === "decompress")
            .every((read) => read.outputLimit < 35 * 1024 * 1024),
          "large compressed JSON must be deferred before decompression",
        ).toBe(true);
        if (variant === "stored body") {
          expect(
            reads
              .flatMap((read) => (read.kind === "cache-row" && read.key === row.key ? [read] : []))
              .every((read) => read.blobBytes === 0),
            "oversized stored bodies must remain inside SQLite",
          ).toBe(true);
        }
      });
    }
  });
});
