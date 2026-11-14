import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined as requireValue } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  encodeSessionArchiveContent,
  resolveSessionArchiveReadPath,
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
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
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
import { usageCostPartitionKey } from "./session-cost-usage-partitions.js";
import { USAGE_COST_QUARTER_SCOPE } from "./session-cost-usage-quarters.js";
import { observeUsageWorkerReads } from "./session-cost-usage-worker-io.test-support.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
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

it("reads recorded usage across append, rewrite, and rollup replacement without transcript scans", async () => {
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
      const sessionFile = formatSqliteSessionFileMarker({ ...scope, storePath: database.path });
      const refresh = () => refreshUsage({ agentId: "main", sessionFiles: [sessionFile] });
      const cached = (reportBudgetBytes?: number) =>
        loadCached({
          agentId: "main",
          sessions: [{ sessionFile }],
          requestRefresh: false,
          reportBudgetBytes,
        });
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
      await probe.clear();
      expect(await discoverAllSessions({ agentId: "main" })).toEqual([
        { sessionId: scope.sessionId, sessionFile, mtime: expect.any(Number) },
      ]);
      expect(await cached()).toMatchObject({ summaries: [{ totalTokens: 3 }] });
      expect(
        await loadCostUsageSummaryFromCache({
          agentId: "main",
          startMs: 0,
          endMs: Date.UTC(2030, 0, 1) - 1,
          dayBucket: utcBucket,
          requestRefresh: false,
        }),
      ).toMatchObject({
        totals: { totalTokens: 3, totalCost: 3 },
        cacheStatus: { status: "fresh" },
      });
      expect(await loadSessionCostSummary({ agentId: "main", sessionFile })).toMatchObject({
        totalTokens: 3,
        totalCost: 3,
      });
      expect(await cached(0)).toMatchObject({
        summaries: [null],
        cacheStatus: { status: "partial", staleFiles: 0 },
      });
      await expectNoRead(probe, "transcript-stats");
      await probe.clear();
      await refresh();
      await expectNoRead(probe, "cache");
      await expectNoRead(probe, "transcript-stats");
      await refreshUsage({ agentId: "main" });
      await expectNoRead(probe, "transcript-stats");
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
      await probe.clear();
      expect(await cached()).toMatchObject({
        summaries: [null],
        cacheStatus: { status: "stale" },
      });
      expect(await cached(0)).toMatchObject({
        summaries: [null],
        cacheStatus: { status: "stale", staleFiles: 1 },
      });
      await expectNoRead(probe, "transcript-stats");
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
      transact((owner) => append(owner, [message("fourth", "third", 5)]));
      await probe.clear();
      expect(await cached()).toMatchObject({
        summaries: [{ totalTokens: 14, staleSince: expect.any(Number) }],
        cacheStatus: { status: "partial" },
      });
      await expectNoRead(probe, "transcript-stats");
      await probe.clear();
      await refresh();
      const appendReads = await probe.read();
      expect(appendReads.filter((entry) => entry.kind === "cache")).toEqual([]);
      expect(
        appendReads.filter((entry) => entry.kind === "transcript-stats" && !entry.bounded),
      ).toEqual([]);
      expect(await cached()).toMatchObject({ summaries: [{ totalTokens: 19 }] });

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

it("filters refresh work before reading historical transcripts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { archive } = await writeArchive(state.stateDir, "excluded-archive");
    const { archive: recordedArchive } = await writeArchive(state.stateDir, "recorded-archive");
    const probe = await observeUsageWorkerReads(state.stateDir, [archive, recordedArchive]);
    await probe.run(async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const historical = ["uncached-history", "recorded-history"].map((sessionId) => {
        const scope = resolveSqliteTranscriptScope({
          agentId: "main",
          sessionKey: `agent:main:${sessionId}`,
          sessionId,
          storePath: database.path,
        });
        return {
          scope,
          sessionFile: formatSqliteSessionFileMarker({ ...scope, storePath: database.path }),
        };
      });
      const transact = <T>(write: (owner: typeof database) => T) =>
        runOpenClawAgentWriteTransaction(write, { agentId: "main", path: database.path });
      for (const { scope } of historical) {
        transact((owner) => {
          writeSessionEntry(owner, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
          appendTranscriptEventsInTransaction(
            owner,
            scope,
            [
              { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId },
              { ...assistantEntry(10, { cost: 1 }), id: "first", parentId: null },
            ],
            { scheduleProjectionReconcile: false },
          );
        });
      }
      const sessions = await writeSessions(
        await sessionsDirectory(state.stateDir),
        ["current", "quarter-gap", "removed"],
        (index) => assistantEntry(index + 2, { cost: 1 }),
      );
      const current = sessions[0]!;
      const gap = sessions[1]!;
      const recorded = historical[1]!;
      await refreshUsage({
        agentId: "main",
        sessionFiles: [recorded.sessionFile, recordedArchive, ...sessionPaths(sessions)],
      });
      const retained = storedRollup(recorded.sessionFile);
      const archiveReadPath = resolveSessionArchiveReadPath(
        recordedArchive,
        await fs.stat(recordedArchive),
      );
      const retainedArchive = storedRollup(archiveReadPath);
      const quarterKey = usageCostPartitionKey(gap.sessionFile, "2026-09-01");
      transact((owner) => {
        owner.db
          .prepare("DELETE FROM cache_entries WHERE scope = ? AND key = ?")
          .run(USAGE_COST_QUARTER_SCOPE, quarterKey);
        appendTranscriptEventsInTransaction(
          owner,
          recorded.scope,
          [{ ...assistantEntry(7, { cost: 1 }), id: "second", parentId: "first" }],
          { scheduleProjectionReconcile: false },
        );
      });
      await fs.rm(sessions[2]!.sessionFile);
      await fs.appendFile(
        current.sessionFile,
        JSON.stringify(assistantEntry(2, { cost: 1 })) + "\n",
      );
      // Keep the SQLite owner's mutation timestamps intact; only this file is in range.
      const startMs = Date.now() + 86_400_000;
      await fs.utimes(current.sessionFile, new Date(startMs), new Date(startMs));
      await probe.clear();
      expect(await refreshUsage({ agentId: "main", startMs })).toBe("refreshed");
      await expectNoRead(probe, "transcript-stats");
      await expectNoRead(probe);
      expect(storedRollup(recorded.sessionFile)).toEqual(retained);
      expect(storedRollup(archiveReadPath)).toEqual(retainedArchive);
      expect(
        readRows("main")
          .map((row) => row.key)
          .toSorted(),
      ).toEqual(
        [recorded.sessionFile, archiveReadPath, current.sessionFile, gap.sessionFile].toSorted(),
      );
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM cache_entries WHERE scope = ? AND key = ?")
          .get(USAGE_COST_QUARTER_SCOPE, quarterKey),
      ).toEqual({ count: 1 });
      expect(
        await loadCached({
          agentId: "main",
          sessions: [current, gap],
          requestRefresh: false,
        }),
      ).toMatchObject({ summaries: [{ totalTokens: 4 }, { totalTokens: 3 }] });

      await probe.clear();
      await refreshUsage({ agentId: "main", startMs, sessionFiles: [recorded.sessionFile] });
      expect((await probe.read()).some((entry) => entry.kind === "transcript-stats")).toBe(true);
      expect(
        await loadCached({
          agentId: "main",
          sessions: [{ sessionFile: recorded.sessionFile }],
          requestRefresh: false,
        }),
      ).toMatchObject({ summaries: [{ totalTokens: 17 }], cacheStatus: { status: "fresh" } });
    });
  });
});

it("refreshes archives from their source and keeps the last usage of one that cannot be decoded", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionsDir = await sessionsDirectory(state.stateDir);
    const header = (id: string) => ({ type: "session", version: 1, id });
    // Past the scanner's bound, an archive record keeps its structure and short
    // strings, so the usage on a huge assistant message still counts.
    const transcripts = {
      healthy: [
        header("healthy"),
        {
          ...assistantEntry(5, { cost: 1, content: "x".repeat(33 * 1024 * 1024) }),
          id: "a",
          parentId: null,
        },
      ],
      undecodable: [header("undecodable"), assistantEntry(6, { cost: 1 })],
    };
    const archives = await Promise.all(
      Object.entries(transcripts).map(async ([sessionId, records]) => {
        const encoded = encodeSessionArchiveContent(
          `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
        );
        const archive = path.join(
          sessionsDir,
          `${sessionId}.jsonl.reset.2026-02-05T12-00-00.000Z${encoded.suffix}`,
        );
        await fs.writeFile(archive, encoded.bytes);
        return archive;
      }),
    );
    setRuntimeConfigSnapshot({});
    const [live] = await writeSessions(sessionsDir, ["live"], () => assistantEntry(3, { cost: 1 }));
    const [healthy, undecodable] = archives as [string, string];
    const keyOf = async (archive: string) =>
      resolveSessionArchiveReadPath(archive, await fs.stat(archive));
    const read = (sessionFile: string) =>
      loadCached({ agentId: "main", sessions: [{ sessionFile }], requestRefresh: false });
    const totalOf = async (sessionFile: string) =>
      (await read(sessionFile)).summaries[0]?.totalTokens;
    expect(await refreshUsage({ agentId: "main" })).toBe("refreshed");
    const healthyKey = await keyOf(healthy);
    expect([await totalOf(healthy), await totalOf(undecodable)]).toEqual([5, 6]);
    // Usage decodes archives as a stream; it never writes plaintext copies.
    expect(existsSync(healthyKey) || existsSync(await keyOf(undecodable))).toBe(false);

    // Upgrade: rows checkpointed against a decompressed copy rescan once from the source.
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const legacy = JSON.parse(storedRollup(healthyKey).valueJson);
    legacy.checkpoint = { ...legacy.checkpoint, observedSize: 34 * 1024 * 1024, inode: 1 };
    database.db
      .prepare("UPDATE cache_entries SET value_json = ? WHERE key = ?")
      .run(JSON.stringify(legacy), healthyKey);

    // A damaged archive gets a new identity; its previous usage moves to it.
    const bytes = await fs.readFile(undecodable);
    bytes.write("oops", 0);
    await fs.writeFile(undecodable, bytes);
    await fs.utimes(undecodable, new Date(), new Date(Date.now() + 60_000));
    await fs.appendFile(live!.sessionFile, `${JSON.stringify(assistantEntry(4, { cost: 1 }))}\n`);

    // A targeted refresh alone must find the prior identity's totals.
    expect(
      await refreshUsage({ agentId: "main", sessionFiles: [undecodable, live!.sessionFile] }),
    ).toBe("refreshed");
    expect(await totalOf(undecodable)).toBe(6);
    expect((await read(undecodable)).cacheStatus).toMatchObject({ staleFiles: 1 });
    expect(await refreshUsage({ agentId: "main" })).toBe("refreshed");
    expect(JSON.parse(storedRollup(healthyKey).valueJson).checkpoint).toMatchObject({
      observedSize: (await fs.stat(healthy)).size,
    });
    expect([
      await totalOf(healthy),
      await totalOf(undecodable),
      await totalOf(live!.sessionFile),
    ]).toEqual([5, 6, 7]);
    expect(readRows("main")).toHaveLength(3);
  });
});

it.each(["table-missing", "schema-missing"] as const)(
  "preserves usage rollups when source metadata is unavailable (%s)",
  async (reason) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const source = openOpenClawAgentDatabase({
        agentId: "main",
        path: state.path("usage-source.sqlite"),
      });
      const scope = resolveSqliteTranscriptScope({
        agentId: "main",
        sessionKey: "agent:main:unavailable-source",
        sessionId: "unavailable-source",
        storePath: source.path,
      });
      const sessionFile = formatSqliteSessionFileMarker({ ...scope, storePath: source.path });
      const params = { agentId: "main", storePath: source.path };
      const append = (events: Parameters<typeof appendTranscriptEventsInTransaction>[2]) =>
        runOpenClawAgentWriteTransaction(
          (owner) =>
            appendTranscriptEventsInTransaction(owner, scope, events, {
              scheduleProjectionReconcile: false,
            }),
          { agentId: "main", path: source.path },
        );
      append([
        { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId },
        { ...assistantEntry(10, { cost: 1 }), id: "first", parentId: null },
      ]);
      await refreshUsage({ ...params, sessionFiles: [sessionFile] });
      const before = readRows("main");
      expect(before).toHaveLength(1);
      const pricingFingerprint = JSON.parse(before[0]!.valueJson).pricingFingerprint as string;
      append([{ ...assistantEntry(7, { cost: 1 }), id: "second", parentId: "first" }]);
      const table = reason === "table-missing" ? "transcript_events" : "schema_meta";
      source.db.exec(`ALTER TABLE ${table} RENAME TO unavailable_usage_source`);
      try {
        await expect(refreshUsage(params)).rejects.toMatchObject({
          name: "SessionMetadataUnavailableError",
          reason,
        });
        expect(readRows("main")).toEqual(before);
        await expect(
          runUsageCostWorker(prepareUsageCostWorker(params), {
            kind: "summary",
            pricingFingerprint,
            startMs: 0,
            endMs: Date.now(),
            dayBucket: utcBucket,
          }),
        ).resolves.toMatchObject({
          kind: "summary",
          summary: {
            totals: { totalTokens: reason === "table-missing" ? 10 : 0 },
            ...(reason === "table-missing"
              ? { cacheStatus: { status: "partial", staleFiles: 1 } }
              : {}),
          },
        });
        expect(readRows("main")).toEqual(before);
      } finally {
        source.db.exec(`ALTER TABLE unavailable_usage_source RENAME TO ${table}`);
      }
      if (reason === "table-missing") {
        await closeOpenClawAgentDatabaseByPathAsync(source.path);
        unregisterOpenClawAgentDatabase({ agentId: "main", path: source.path });
        await fs.rm(source.path);
        expect(await refreshUsage(params)).toBe("refreshed");
        expect(readRows("main")).toEqual([]);
      }
    });
  },
);

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
      await expectNoRead(reads);
      expect(
        await loadSessionCostSummary({ agentId: "main", sessionFile: archive }),
      ).not.toBeNull();
      expect((await reads.read()).some((entry) => entry.kind === "transcript")).toBe(true);
    });
  },
);

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
