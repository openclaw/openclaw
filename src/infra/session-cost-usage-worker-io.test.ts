import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { setEnvironmentData, Worker } from "node:worker_threads";
import { expectDefined as requireValue } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { observeWorkerActivity } from "../../test/helpers/worker-activity.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
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
import { markCanonicalSessionValidationPending } from "../config/sessions/session-canonical-key.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent as refreshUsage } from "./session-cost-usage-aggregation.js";
import {
  acquireUsageLock,
  createUsageCacheWrite,
} from "./session-cost-usage-cache.fixtures.test-support.js";
import { writeSessionCostUsageRollupsInDatabase as writeRollups } from "./session-cost-usage-cache.kernel.js";
import {
  readSessionCostUsageRollupRows as readRows,
  readSessionCostUsageRollupEntry as readEntry,
} from "./session-cost-usage-cache.test-support.js";
import {
  createUsageTranscriptEntry as assistantEntry,
  encodeOversizedUsageRollup,
} from "./session-cost-usage-fixtures.test-support.js";
import {
  observeUsageWorkerReads,
  withUsageWorkerPreload,
} from "./session-cost-usage-worker-io.test-support.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadSessionCostSummary,
  loadSessionCostSummariesFromCache as loadCached,
} from "./session-cost-usage.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function transcriptText(sessionId: string, entry: unknown): string {
  return [
    JSON.stringify({ type: "session", version: 1, id: sessionId }),
    JSON.stringify(entry),
    "",
  ].join("\n");
}

async function sessionsDirectory(root: string, agentId = "main") {
  const dir = path.join(root, "agents", agentId, "sessions");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeSessions(dir: string, ids: string[], entry: (index: number) => unknown) {
  return Promise.all(
    ids.map(async (sessionId, index) => {
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      await fs.writeFile(sessionFile, transcriptText(sessionId, entry(index)));
      return { sessionId, sessionFile };
    }),
  );
}

const sessionPaths = (sessions: Array<{ sessionFile: string }>) =>
  sessions.map(({ sessionFile }) => sessionFile);
const utcBucket = { mode: "utc-offset" as const, utcOffsetMinutes: 0 };
const archiveEntry = {
  type: "message",
  message: {
    role: "user",
    content: "synthetic archived message",
  },
};
async function writeArchive(root: string, sessionId: string, encoding: "plain" | "zstd" = "zstd") {
  const content = transcriptText(sessionId, archiveEntry);
  const encoded =
    encoding === "plain"
      ? { suffix: "", bytes: Buffer.from(content) }
      : encodeSessionArchiveContent(content);
  const archive = path.join(
    await sessionsDirectory(root),
    `${sessionId}.jsonl.reset.2026-02-05T12-00-00.000Z${encoded.suffix}`,
  );
  await fs.writeFile(archive, encoded.bytes);
  return { archive, encoded };
}
type ReadProbe = Awaited<ReturnType<typeof observeUsageWorkerReads>>;
async function expectNoRead(
  probe: ReadProbe,
  kind: Awaited<ReturnType<ReadProbe["read"]>>[number]["kind"] = "transcript",
) {
  expect((await probe.read()).filter((entry) => entry.kind === kind)).toEqual([]);
}

function storedRollup(sessionFile: string, agentId = "main") {
  return requireValue(
    readRows(agentId).find((row) => row.key === sessionFile),
    "expected stored rollup",
  );
}

it("refuses unvalidated legacy session keys before assigning usage ownership", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db.exec(`
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at)
        VALUES ('legacy', 'legacy-session', '{"sessionId":"legacy-session","updatedAt":1}', 1, 1);
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at, transcript_updated_at)
        VALUES ('legacy-session', 'legacy', 1, 1, 1);
    `);
    markCanonicalSessionValidationPending(database, ["legacy"]);
    await closeOpenClawAgentDatabasesAsync();

    await expect(discoverAllSessions({ agentId: "main" })).rejects.toThrow("openclaw doctor --fix");
  });
});

it("reuses discovered inputs and rollups across append, rewrite, and rollup replacement", async () => {
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
      const sessionFile = formatSqliteSessionFileMarker({
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        storePath: database.path,
      });
      const refresh = () => refreshUsage({ agentId: "main", sessionFiles: [sessionFile] });
      const cached = () =>
        loadCached({ agentId: "main", sessions: [{ sessionFile }], requestRefresh: false });
      expect(await cached()).toMatchObject({
        summaries: [null],
        cacheStatus: { status: "stale", cachedFiles: 0, pendingFiles: 1, staleFiles: 1 },
      });
      await expectNoRead(probe, "transcript-stats");
      const transact = <T>(write: (owner: typeof database) => T) =>
        runOpenClawAgentWriteTransaction(write, { agentId: scope.agentId, path: database.path });
      const append = (
        owner: typeof database,
        events: Parameters<typeof appendTranscriptEventsInTransaction>[2],
      ) =>
        appendTranscriptEventsInTransaction(owner, scope, events, {
          scheduleProjectionReconcile: false,
        });
      const message = (id: string, parentId: string | null, tokens: number) => ({
        ...assistantEntry(tokens, { cost: tokens }),
        id,
        parentId,
      });
      const first = message("first", null, 1);
      transact((owner) => {
        writeSessionEntry(owner, scope.sessionKey, {
          sessionId: scope.sessionId,
          updatedAt: 1,
        });
        append(owner, [
          { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId },
          first,
          message("second", "first", 2),
        ]);
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
          await loadCached({ agentId: "main", sessions, requestRefresh: false }),
        ).toMatchObject({ summaries, cacheStatus: { status } });
        await expectNoRead(probe, "transcript-stats");
      };
      await expectDiscovered(discovered, [{ totalTokens: 3 }], "fresh");
      await probe.clear();
      await refresh();
      await expectNoRead(probe, "cache");
      const generation = transact((owner) => {
        const rewritten = rewriteSqliteTranscriptEventRowsInTransaction(owner, scope, [
          {
            seq: 1,
            expectedEventJson: JSON.stringify(first),
            event: message("first", null, 8),
          },
        ]);
        append(owner, [message("third", "second", 4)]);
        return rewritten;
      });
      expect(generation).toEqual(expect.any(String));
      const rewrittenDiscovery = await discoverAllSessions({ agentId: "main" });
      await expectDiscovered(rewrittenDiscovery, [null], "stale");
      await probe.clear();
      await refresh();
      expect(await cached()).toMatchObject({
        summaries: [{ totalTokens: 14, totalCost: 14 }],
        cacheStatus: { status: "fresh" },
      });
      const row = storedRollup(sessionFile);
      expect(JSON.parse(row.valueJson)).toMatchObject({
        checkpoint: { kind: "sqlite", generation, maxSeq: 3, eventCount: 4 },
      });
      const reads = await probe.read();
      expect(reads.some((entry) => entry.kind === "transcript-stats")).toBe(true);
      expect(reads.filter((entry) => entry.kind === "hot-watermark")).toEqual([]);
      await expectDiscovered(discovered, [null], "partial");
      discovered = rewrittenDiscovery;
      transact((owner) => append(owner, [message("fourth", "third", 5)]));
      await probe.clear();
      await refresh();
      const appendReads = await probe.read();
      expect(appendReads.filter((entry) => entry.kind === "cache")).toEqual([]);
      expect(await cached()).toMatchObject({ summaries: [{ totalTokens: 19 }] });
      await expectDiscovered(discovered, [{ totalTokens: 19 }], "fresh");

      // Another in-process writer replaces the derived row. Its receipt must
      // invalidate the retained rollup before refresh rebuilds it from canonical stats.
      transact((owner) =>
        writeRollups(owner.db, [createUsageCacheWrite(sessionFile, "{}", Date.now())]),
      );
      await refresh();
      expect(await cached()).toMatchObject({ summaries: [{ totalTokens: 19 }] });
    });
  });
});

it.each(["zstd", "plain"] as const)(
  "inventories %s archives without reading payloads and materializes only for a summary",
  async (encoding) => {
    const root = tempDirs.make("openclaw-usage-worker-metadata-");
    const sessionId = `metadata-${encoding}`;
    const { archive } = await writeArchive(root, sessionId, encoding);
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
      await expectNoRead(reads);
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
  const { archive, encoded } = await writeArchive(root, "native-archive");
  expect(encoded.suffix).toBe(".zst");
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
const { BroadcastChannel, getEnvironmentData, isMainThread, threadId } = require("node:worker_threads");
if (!isMainThread) {
  const transform = zlib.ZstdDecompress.prototype._transform;
  zlib.ZstdDecompress.prototype._transform = function(chunk, encoding, callback) {
    if (!this.__held) {
      this.__held = true;
      fs.writeFileSync(${JSON.stringify(entered)}, String(threadId));
      const activity = new BroadcastChannel(${JSON.stringify(`${entered}:activity`)});
      activity.postMessage(threadId);
      activity.close();
      const release = new Int32Array(getEnvironmentData(${JSON.stringify(entered)}));
      while (Atomics.load(release, 0) === 0) Atomics.wait(release, 0, 0);
      fs.writeFileSync(${JSON.stringify(completed)}, "complete");
    }
    return Reflect.apply(transform, this, [chunk, encoding, callback]);
  };
  require("node:module").syncBuiltinESMExports();
}
`,
  );
  try {
    await withUsageWorkerPreload(root, preload, async () => {
      using terminate = vi.spyOn(Worker.prototype, "terminate");
      const activeWorker = observeWorkerActivity(`${entered}:activity`);
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
        // The durable marker precedes both the activity receipt and summary settlement.
        const worker = await withinTest(
          Promise.race([
            activeWorker,
            outcome.then(async () => {
              expect(Number(await fs.readFile(entered, "utf8"))).toBeGreaterThan(0);
              return activeWorker;
            }),
          ]),
          signal,
        );
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
        expect({ summarySettled, drainSettled, termination }).toEqual({
          summarySettled: false,
          drainSettled: false,
          termination: -1,
        });
        expect(worker.threadId).toBeGreaterThan(0);
        releaseNative();
        expect(await outcome).toMatchObject({ status: "rejected" });
        await draining;
        expect(await fs.readFile(completed, "utf8")).toBe("complete");
        expect(worker.threadId).toBe(-1);
        expect(scope.hasPendingWork).toBe(false);
      } finally {
        releaseNative();
        scope.beginClose(reason);
        await outcome;
        await scope.drain();
      }
    });
  } finally {
    setEnvironmentData(entered, undefined);
    await fs.rm(archive, { force: true });
    await expect(materializeSessionArchiveForRead(archive)).rejects.toThrow(/ENOENT/);
  }
}, 20_000);

it("increments from the durable byte offset and rebuilds after truncation", async () => {
  const root = tempDirs.make("openclaw-usage-worker-incremental-");
  const sessionsDir = await sessionsDirectory(root);
  const sessionFile = path.join(sessionsDir, "sess-incremental.jsonl");
  const line = (timestamp: string, tokens: number, content = "") =>
    JSON.stringify(
      assistantEntry(tokens, {
        timestamp,
        cost: tokens / 1000,
        content,
        provider: "openai",
        model: "gpt-5.5",
      }),
    );
  await fs.writeFile(
    sessionFile,
    [
      line("2026-02-05T12:00:00.000Z", 10, "🦞".repeat(32 * 1024)),
      line("2026-02-05T12:01:00.000Z", 20),
    ].join("\n"),
    "utf-8",
  );

  const probe = await observeUsageWorkerReads(root, [sessionFile]);
  const summary = () => loadSessionCostSummary({ sessionFile, agentId: "main" });
  const storedEntry = (): {
    checkpoint: { kind: "jsonl"; parsedOffset: number };
    parsedRecords: number;
  } => JSON.parse(storedRollup(sessionFile).valueJson);
  const readStarts = async () =>
    (await probe.read()).flatMap((entry) =>
      entry.kind === "transcript" && entry.method === "createReadStream" ? [entry.start] : [],
    );
  await probe.run(async () => {
    expect(await summary()).toMatchObject({ totalTokens: 30 });
    const initialEntry = storedEntry();
    expect(initialEntry).toMatchObject({
      checkpoint: { parsedOffset: (await fs.stat(sessionFile)).size },
      parsedRecords: 2,
    });

    await probe.clear();
    await fs.appendFile(sessionFile, `\n${line("2026-02-05T12:02:00.000Z", 5)}`, "utf-8");
    expect(await summary()).toMatchObject({ totalTokens: 35 });
    expect(await readStarts()).toEqual([initialEntry.checkpoint.parsedOffset]);

    const completeSize = (await fs.stat(sessionFile)).size;
    await fs.appendFile(sessionFile, '\n{"type":"message","timestamp":"2026-02-05', "utf-8");
    expect((await summary())?.totalTokens).toBe(35);
    expect(storedEntry().checkpoint.parsedOffset).toBe(completeSize + 1);
    await fs.appendFile(
      sessionFile,
      'T12:03:00.000Z","message":{"role":"assistant","usage":{"input":7,"output":0,"totalTokens":7,"cost":{"total":0.007}}}}',
      "utf-8",
    );
    expect((await summary())?.totalTokens).toBe(42);

    await probe.clear();
    await fs.writeFile(sessionFile, line("2026-02-05T13:00:00.000Z", 11), "utf-8");
    expect(await summary()).toMatchObject({ totalTokens: 11 });
    expect(await readStarts()).toEqual([0]);
    expect(storedEntry().parsedRecords).toBe(1);
  });
});

it("loads multiple session summaries and fractional model costs from one durable cache snapshot", async () => {
  const root = tempDirs.make("openclaw-usage-worker-selection-");
  const sessionsDir = await sessionsDirectory(root);
  const sessions = await writeSessions(sessionsDir, ["sess-a", "sess-b"], (index) =>
    assistantEntry(index + 1, {
      timestamp: `2026-02-05T23:0${index}:00.000Z`,
      provider: "custom",
      model: "unpriced-batch",
    }),
  );
  const records = [
    { timestamp: "2026-02-05T23:00:00Z", costs: [0.1, 0.9] },
    { timestamp: "2026-02-05T23:15:00Z", costs: [0.2, 0.8] },
    { timestamp: "2026-02-05T23:16:00Z", costs: [0.3, 0.7] },
  ].flatMap(({ timestamp, costs }) =>
    costs.map((cost, index) =>
      JSON.stringify(
        assistantEntry(1, { timestamp, provider: "test", model: `model-${index}`, cost }),
      ),
    ),
  );
  await fs.appendFile(sessions[0]!.sessionFile, records.join("\n") + "\n");
  const probe = await observeUsageWorkerReads(root, sessionPaths(sessions));
  await probe.run(async () => {
    const warmed = await loadCostUsageSummary({
      agentId: "main",
      startMs: Date.UTC(2026, 1, 5),
      endMs: Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1,
    });
    expect(warmed).toMatchObject({
      cacheStatus: { status: "fresh" },
      totals: { missingCostByModel: { "custom/unpriced-batch": 2 } },
    });

    await loadCached({ sessions, agentId: "main" });
    await vi.waitFor(
      async () => {
        const cached = await loadCached({ sessions, agentId: "main", requestRefresh: false });
        expect(cached).toMatchObject({ cacheStatus: { status: "fresh" } });
        expect(cached.summaries.map((summary) => summary?.missingCostByModel)).toEqual([
          { "custom/unpriced-batch": 1 },
          { "custom/unpriced-batch": 1 },
        ]);
      },
      { interval: 10, timeout: 2_000 },
    );

    const selectedRow = requireValue(readRows("main")[0], "expected a selected rollup");
    const selectedEntry = JSON.parse(selectedRow.valueJson) as Record<string, unknown>;
    expect(
      runOpenClawAgentWriteTransaction(
        ({ db }) =>
          writeRollups(db, [
            createUsageCacheWrite(
              path.join(sessionsDir, "unrequested.jsonl"),
              { ...selectedEntry, syntheticPadding: "雪".repeat(400_000) },
              selectedRow.updatedAt,
            ),
          ]),
        { agentId: "main" },
        { operationLabel: "session-cost-usage.rollup.write" },
      ),
    ).toBe(true);

    await probe.clear();
    await refreshUsage({ agentId: "main", sessionFiles: [sessions[0]!.sessionFile] });
    expect(
      (await probe.read()).flatMap((entry) => (entry.kind === "cache-row" ? [entry.key] : [])),
    ).toEqual([sessions[0]!.sessionFile]);
    expect(readRows("main").some((row) => row.key.endsWith("unrequested.jsonl"))).toBe(true);

    const fractional = await loadCached({
      sessions: [sessions[0]!],
      agentId: "main",
      startMs: Date.UTC(2026, 1, 5, 23),
      endMs: Date.UTC(2026, 1, 5, 23, 29, 59, 999),
      dayBucket: utcBucket,
      requestRefresh: false,
    });
    expect(fractional).toMatchObject({
      cacheStatus: { status: "fresh" },
      summaries: [{ totalTokens: 7, totalCost: 3 }],
    });
    const model = fractional.summaries[0]?.modelUsage?.find((entry) => entry.model === "model-0");
    expect(model?.totals.totalCost).toBeCloseTo(0.6, 12);
    await expectNoRead(probe);
    await probe.clear();
    const result = await loadCached({
      sessions,
      agentId: "main",
      startMs: Date.UTC(2026, 1, 5),
      endMs: Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1,
      dayBucket: { mode: "time-zone", timeZone: "Europe/Vienna" },
      requestRefresh: false,
    });

    expect(result).toMatchObject({
      cacheStatus: { status: "fresh" },
      summaries: [
        { totalTokens: 7, totalCost: 3, activityDates: ["2026-02-06"] },
        { totalTokens: 2, activityDates: ["2026-02-06"] },
      ],
    });
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
    ).toEqual(sessionPaths(sessions).toSorted(comparePaths));
  });
});
it("defers oversized exact ranges without treating valid aggregates as corrupt", async () => {
  const agentId = "usage-replay-budget";
  const timestamp = Date.UTC(2026, 8, 18, 0, 1);
  const records =
    JSON.stringify(
      assistantEntry(7, {
        timestamp: new Date(timestamp).toISOString(),
        content: "x".repeat(16 * 1024 * 1024),
        cost: 0.1,
      }),
    ) + "\n";
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionFile = state.path(`${agentId}.jsonl`);
    await fs.writeFile(sessionFile, records);
    await refreshUsage({ config: {}, agentId, sessionFiles: [sessionFile] });
    const probe = await observeUsageWorkerReads(state.stateDir, [sessionFile]);
    await probe.run(async () => {
      const prepared = prepareUsageCostWorker({ agentId, sessionFiles: [sessionFile] });
      const rows = readRows(agentId);
      const pricingFingerprint = JSON.parse(rows[0]!.valueJson).pricingFingerprint as string;
      const exact = await runUsageCostWorker(prepared, {
        kind: "sessions",
        sessions: [{ sessionFile }],
        pricingFingerprint,
        startMs: timestamp,
        endMs: timestamp + 1,
        dayBucket: utcBucket,
      });
      expect(exact).toMatchObject({
        kind: "sessions",
        summaries: [null],
        cacheStatus: { status: "partial", cachedFiles: 0, pendingFiles: 1, staleFiles: 0 },
        staleSessionFiles: [],
        invalidRows: [],
      });
      const computing = await loadCached({
        agentId,
        sessions: [{ sessionFile }],
        startMs: timestamp,
        endMs: timestamp + 1,
      });
      expect(computing).toMatchObject({
        summaries: [null],
        cacheStatus: { status: "partial", pendingFiles: 1, staleFiles: 0 },
      });
      await expectNoRead(probe);
      const aligned = await loadCached({
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
    const sessions = await writeSessions(
      await sessionsDirectory(state.stateDir, agentId),
      ["large", "small"],
      () => assistantEntry(7),
    );
    const sessionFiles = sessionPaths(sessions);
    await refreshUsage({ config: {}, agentId, sessionFiles });
    const row = storedRollup(sessions[0]!.sessionFile, agentId);
    const pricingFingerprint = JSON.parse(row.valueJson).pricingFingerprint as string;
    const original = requireValue(readEntry(row, agentId), "expected valid checkpoint");
    const probe = await observeUsageWorkerReads(state.stateDir, sessionFiles);
    for (const variant of ["stored body", "compressed body", "compressed partition"] as const) {
      const encoded = encodeOversizedUsageRollup(original, variant);
      {
        await using lock = await acquireUsageLock(agentId);
        await lock.writeRollup([
          {
            ...createUsageCacheWrite(row.key, encoded.valueJson, row.updatedAt, encoded.blob),
            partitions: encoded.partitions,
            replacePartitions: true,
          },
        ]);
      }
      await probe.clear();
      await probe.run(async () => {
        const prepared = prepareUsageCostWorker({ agentId, sessionFiles });
        const result = await runUsageCostWorker(prepared, {
          kind: "sessions",
          sessions,
          pricingFingerprint,
          dayBucket: utcBucket,
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
