import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { visitSessionMessagesAsync } from "../../gateway/session-transcript-native.test-support.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { createVerifiedSqliteSnapshot } from "../../infra/sqlite-snapshot.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { flushLogger, setLoggerOverride } from "../../logging/logger.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { copySqliteSessionOwnedStateForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { readRecentSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.js";
import {
  hasSessionTranscriptEventsSync,
  readTranscriptMutationStateSync,
} from "./session-accessor.sqlite-metadata-read.js";
import {
  createTranscriptIdentityReader,
  findTranscriptEventInDatabase,
  loadLatestAssistantText,
  loadTranscriptEventsFromDatabase,
  loadTranscriptEventRowsAfterSeqSync,
  loadTranscriptHeaderSync,
  readTranscriptEventAtSeqSync,
  readTranscriptEventRows,
  readTranscriptStatsBatchReadOnlySync,
  readTranscriptStatsSync,
  readTranscriptStorageRows,
} from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import { readSessionColdStorageInventory } from "./session-cold-storage-inventory.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import * as sqliteTargets from "./session-sqlite-target.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { searchSessionTranscriptsReadOnlySync as searchSessionTranscripts } from "./session-transcript-search.js";

afterEach(() => vi.restoreAllMocks());

let seed:
  | (Awaited<ReturnType<typeof createHotRaceSeed>> & { state: OpenClawTestState })
  | undefined;

beforeAll(async () => {
  const state = await createOpenClawTestState({ label: "cold-read-seed" });
  try {
    const prepared = await createHotRaceSeed(state);
    await state.restoreEnv();
    seed = { ...prepared, state };
  } catch (error) {
    await state.cleanup();
    throw error;
  }
});

afterAll(async () => {
  await seed?.state.cleanup();
  seed = undefined;
});

async function createHotRaceSeed(state: OpenClawTestState) {
  const scope = {
    agentId: "main",
    env: state.env,
    sessionId: "cold-race",
    sessionKey: "agent:main:cold-race",
  };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, [
    { type: "session", id: scope.sessionId, version: 3 },
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: 1,
      message: { role: "user", content: "Original question" },
    },
    {
      type: "message",
      id: "answer",
      parentId: "user",
      timestamp: 2,
      message: { role: "assistant", content: "Original answer" },
    },
  ]);
  const options = { agentId: scope.agentId, env: state.env };
  await waitForSessionTranscriptIndexReconcile(options);
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  runOpenClawAgentWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("session_windows")
        .set({ updated_at: 1, transcript_updated_at: 1 })
        .where("session_id", "=", scope.sessionId),
    );
  }, options);
  const database = openOpenClawAgentDatabase(options);
  await expect(
    runSessionColdStorageMaintenance({
      config: {
        agents: { list: [{ id: "main" }] },
        session: {
          store: database.path,
          maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
        },
      },
    }),
  ).resolves.toMatchObject({ archivedTranscripts: 1 });
  const descriptor = executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<DB>(database.db)
      .selectFrom("session_transcript_cold_archives")
      .selectAll()
      .where("session_id", "=", scope.sessionId),
  )!;
  await restoreSessionColdTranscript(scope);
  expect(descriptor.storage).toBe("file");
  await waitForSessionTranscriptIndexReconcile(options);
  await closeOpenClawAgentDatabaseByPathAsync(database.path, scope.agentId);
  const snapshotPath = state.path("hot-seed.sqlite");
  await createVerifiedSqliteSnapshot({
    sourcePath: database.path,
    targetPath: snapshotPath,
    requireNonEmptySource: true,
    preserveRowIds: true,
  });
  return {
    snapshotPath,
    archivePath: resolveSessionColdArchivePath(database.path, descriptor.archive_name),
    descriptor,
  };
}

async function prepareRace(state: OpenClawTestState) {
  if (!seed) {
    throw new Error("Cold read seed was not prepared");
  }
  const scope = {
    agentId: "main",
    env: state.env,
    sessionId: "cold-race",
    sessionKey: "agent:main:cold-race",
  };
  const options = { agentId: scope.agentId, env: state.env };
  const storePath = resolveOpenClawAgentSqlitePath(options);
  const descriptor = structuredClone(seed.descriptor);
  const archivePath = resolveSessionColdArchivePath(storePath, descriptor.archive_name);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.copyFile(seed.snapshotPath, storePath, fs.constants.COPYFILE_EXCL);
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.copyFile(seed.archivePath, archivePath, fs.constants.COPYFILE_EXCL);
  const database = openOpenClawAgentDatabase(options);
  const writer = new DatabaseSync(database.path);
  writer.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  let committed = false;
  const commitArchive = () => {
    if (committed) {
      return;
    }
    runSqliteImmediateTransactionSync(writer, () => {
      const db = getNodeSqliteKysely<DB>(writer);
      executeSqliteQuerySync(
        writer,
        db.insertInto("session_transcript_cold_archives").values(descriptor),
      );
      deleteSessionTranscriptIndexInTransaction(writer, scope.sessionId);
      executeSqliteQuerySync(
        writer,
        db.deleteFrom("transcript_events").where("session_id", "=", scope.sessionId),
      );
    });
    committed = true;
  };
  const commitAfterMarkerRead = (
    matches = (query: string) => query.includes('from "session_transcript_cold_archives"'),
    afterArchive?: () => void,
  ) => {
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    const prepare = database.db.prepare.bind(database.db);
    vi.spyOn(database.db, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (!matches(query)) {
        return statement;
      }
      const nativeGet = statement.get.bind(statement);
      vi.spyOn(statement, "get").mockImplementation(
        new Proxy(nativeGet, {
          apply(get, _receiver, args) {
            const row = get(...args);
            commitArchive();
            afterArchive?.();
            return row;
          },
        }),
      );
      const nativeAll = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation(
        new Proxy(nativeAll, {
          apply(all, _receiver, args) {
            const rows = all(...args);
            commitArchive();
            afterArchive?.();
            return rows;
          },
        }),
      );
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
        yield* iterate(...args);
        commitArchive();
        afterArchive?.();
        return undefined;
      });
      return statement;
    });
  };
  return {
    scope,
    database,
    writer,
    commitArchive,
    commitAfterMarkerRead,
    committed: () => committed,
  };
}

type Race = Awaited<ReturnType<typeof prepareRace>>;

async function withRace(
  label: string,
  run: (race: Race, state: OpenClawTestState) => Promise<void>,
) {
  await withOpenClawTestState({ label }, async (state) => {
    const race = await prepareRace(state);
    try {
      await run(race, state);
    } finally {
      vi.restoreAllMocks();
      race.writer.close();
    }
  });
}
const readers: Array<{ name: string; read: (race: Race) => unknown }> = [
  {
    name: "history page",
    read: ({ scope }) =>
      readRecentSessionTranscriptHistoryEvents(scope, {
        maxMessages: 20,
        maxLines: 20,
        maxBytes: 64 * 1024,
      }),
  },
  { name: "header", read: ({ scope }) => loadTranscriptHeaderSync(scope) },
  { name: "checkpoint suffix", read: ({ scope }) => loadTranscriptEventRowsAfterSeqSync(scope, 0) },
  { name: "checkpoint row", read: ({ scope }) => readTranscriptEventAtSeqSync(scope, 1) },
  {
    name: "raw rows",
    read: ({ database, scope }) => readTranscriptEventRows(database, scope.sessionId),
  },
  {
    name: "storage rows",
    read: ({ database, scope }) => readTranscriptStorageRows(database, scope.sessionId),
  },
  {
    name: "events",
    read: ({ database, scope }) => loadTranscriptEventsFromDatabase(database, scope.sessionId),
  },
  {
    name: "find",
    read: ({ database, scope }) =>
      findTranscriptEventInDatabase(database, scope.sessionId, () => true),
  },
  { name: "latest assistant", read: ({ scope }) => loadLatestAssistantText(scope) },
  {
    name: "identity",
    read: ({ database, scope }) =>
      createTranscriptIdentityReader(database, scope.sessionId)("user"),
  },
];

it.each(readers)(
  "keeps $name in the hot snapshot when another connection archives after the marker read",
  async ({ read }) => {
    await withRace("cold-read-snapshot", async (race) => {
      const original = read(race);
      expect(original).toBeDefined();
      race.commitAfterMarkerRead();
      expect(read(race)).toEqual(original);
      expect(race.committed()).toBe(true);
      expect(() => read(race)).toThrow(/cold storage/);
    });
  },
);

it("checks a cached identity reader when invoked after another connection archives", async () => {
  await withRace("cold-cached-identity", async (race) => {
    const read = createTranscriptIdentityReader(race.database, race.scope.sessionId);
    expect(read("user")).toMatchObject({ eventId: "user", seq: 1 });
    race.commitArchive();
    expect(() => read("user")).toThrow(/cold storage/);
  });
});

it("identifies a slow transcript matcher while retaining its hot read snapshot", async () => {
  await withOpenClawTestState({ label: "hot-read-attribution" }, async (state) => {
    const race = await prepareRace(state);
    const file = state.path("hot-read.log");
    setLoggerOverride({ level: "info", consoleLevel: "silent", file });
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const found = findTranscriptEventInDatabase(race.database, race.scope.sessionId, () => {
        expect(race.database.db.isTransaction).toBe(true);
        clock += 1_200;
        race.commitArchive();
        return true;
      });
      expect(found).toMatchObject({ event: { id: "answer" } });
      expect(race.database.db.isTransaction).toBe(false);
      expect(() => loadTranscriptHeaderSync(race.scope)).toThrow(/cold storage/);
      await flushLogger();
      const holds = (await fs.readFile(file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.message === "slow SQLite transaction hold")
        .map((record) => record["1"]);
      expect(holds).toEqual([
        {
          async: false,
          database: race.database.path,
          elapsedMs: 1_200,
          isMainThread,
          mode: "deferred",
          operation: "session transcript match read",
          pid: process.pid,
          threadId,
          thresholdMs: 1_000,
        },
      ]);
    } finally {
      vi.restoreAllMocks();
      race.writer.close();
      await flushLogger();
      setLoggerOverride(null);
    }
  });
});

it("counts a header at seq zero as transcript presence", async () => {
  await withOpenClawTestState({ label: "transcript-presence" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "presence",
      sessionKey: "agent:main:presence",
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    expect(hasSessionTranscriptEventsSync(scope)).toBe(false);
    await replaceTranscriptEvents(scope, [{ type: "session", id: scope.sessionId, version: 3 }]);
    expect(readTranscriptStatsSync(scope)).toMatchObject({ eventCount: 1, maxSeq: 0 });
    expect(hasSessionTranscriptEventsSync(scope)).toBe(true);
  });
});

it.each([false, true])(
  "bounds hot and cold transcript stats selections with batch=%s",
  async (batch) => {
    await withRace("cold-stats-query-budget", async (race) => {
      const expectedStats = readTranscriptStatsSync(race.scope);
      const scopes = [
        race.scope,
        ...Array.from({ length: 410 }, (_, index) => ({
          ...race.scope,
          sessionId: `missing-${index}`,
        })),
        race.scope,
      ];
      const read = batch
        ? () => readTranscriptStatsBatchReadOnlySync(scopes)
        : () => [readTranscriptStatsSync(race.scope)];
      const expected = batch
        ? scopes.map((scope) =>
            scope.sessionId === race.scope.sessionId
              ? expectedStats
              : { eventCount: 0, maxSeq: 0, sizeBytes: 0 },
          )
        : [expectedStats];
      const reads = trackSqliteStatementExecutions(race.database.db, ["stats"], (query) =>
        query.startsWith("select ") &&
        /"(?:transcript_events|session_transcript_cold_archives|session_windows)"/u.test(query)
          ? "stats"
          : null,
      );
      try {
        const first = read();
        expect(first).toEqual(expected);
        if (batch) {
          expect(first[0]).not.toBe(first.at(-1));
        }
        race.commitArchive();
        expect(read()).toEqual(expected);
        expect(reads.counts.stats).toBeLessThanOrEqual(batch ? 12 : 2);
        expect(reads.rowCounts.stats).toBeLessThanOrEqual(batch ? 4 : 2);
      } finally {
        reads.restore();
      }
    });
  },
);

it.each(["stats", "batch stats", "search", "presence", "mutation"] as const)(
  "keeps %s coherent when another connection archives",
  async (kind) => {
    await withRace("cold-metadata-snapshot", async (race) => {
      const read = {
        stats: () => readTranscriptStatsSync(race.scope),
        "batch stats": () =>
          readTranscriptStatsBatchReadOnlySync([
            race.scope,
            ...Array.from({ length: 10 }, (_, index) => ({
              ...race.scope,
              sessionId: `missing-${index}`,
            })),
          ]),
        search: () => searchSessionTranscripts({ ...race.scope, query: "Original" }),
        presence: () => hasSessionTranscriptEventsSync(race.scope),
        mutation: () => readTranscriptMutationStateSync(race.scope),
      }[kind];
      const original = read();
      race.commitAfterMarkerRead(
        (query) =>
          kind === "mutation"
            ? query.includes('from "session_windows"')
            : kind === "batch stats"
              ? query.includes('from "transcript_events"')
              : query.includes('"session_transcript_cold_archives"'),
        kind === "batch stats"
          ? () => {
              race.writer
                .prepare(
                  "UPDATE session_windows SET transcript_updated_at = 222 WHERE session_id = ?",
                )
                .run(race.scope.sessionId);
            }
          : undefined,
      );
      expect(read()).toEqual(original);
      expect(race.committed()).toBe(true);
      if (kind === "search") {
        expect(read()).toMatchObject({ hits: [], archivedTranscriptsExcluded: 1 });
      } else if (kind === "batch stats") {
        expect(read()).toEqual(
          expect.arrayContaining([expect.objectContaining({ lastMutationAtMs: 222 })]),
        );
      } else {
        expect(read()).toEqual(original);
      }
    });
  },
);

it("discards every batched result for a store that loses a table between chunks", async () => {
  await withRace("stats-batch-table-race", async (race) => {
    const scopes = Array.from({ length: 411 }, (_, index) => ({
      ...race.scope,
      sessionId: index === 0 ? race.scope.sessionId : `missing-${index}`,
    }));
    race.commitAfterMarkerRead(undefined, () => race.writer.exec("DROP TABLE transcript_events"));
    expect(readTranscriptStatsBatchReadOnlySync(scopes)).toEqual(scopes.map(() => null));
    expect(race.committed()).toBe(true);
  });
});

it("preserves partial-store statistics, UTF-8 bytes, and scope-cache freshness in batches", async () => {
  await withOpenClawTestState({ label: "stats-batch-partial-store" }, async (state) => {
    const options = { agentId: "main", env: state.env, path: state.statePath("shared.sqlite") };
    const database = openOpenClawAgentDatabase(options);
    const rawId = "orphan-\ud800";
    const raw = ` { "message": { "content": "${"🦞".repeat(4096)}" } } `;
    database.db.exec("PRAGMA foreign_keys = OFF");
    database.db
      .prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, 1)",
      )
      .run(rawId, 9, raw);
    database.db
      .prepare(`INSERT INTO session_transcript_cold_archives (
      session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
      archive_bytes, last_seq, archived_at, storage
    ) VALUES (?, 'generation', 'synthetic.jsonl.zst', ?, 7, 8181, 32, 22, 1, 'file')`)
      .run("orphan-cold", "0".repeat(64));
    database.db.exec("PRAGMA foreign_keys = ON");
    const scope = { agentId: "logical", env: state.env, storePath: database.path };
    const ids = [
      rawId,
      "orphan-cold",
      ...Array.from({ length: 10 }, (_, index) => `missing-${index}`),
      rawId,
    ];
    const scopes = ids.map((sessionId) => ({ ...scope, sessionId }));
    const expected = ids.map((id) =>
      id === rawId
        ? { eventCount: 1, maxSeq: 9, sizeBytes: Buffer.byteLength(raw) }
        : id === "orphan-cold"
          ? { eventCount: 7, maxSeq: 22, sizeBytes: 8181 }
          : { eventCount: 0, maxSeq: 0, sizeBytes: 0 },
    );
    const resolve = vi.spyOn(sqliteTargets, "resolveSqliteTargetFromSessionStorePath");
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        resolve.mockClear();
        const result = readTranscriptStatsBatchReadOnlySync(scopes);
        expect(result).toEqual(expected);
        expect(result[0]).not.toBe(result.at(-1));
        expect(resolve).toHaveBeenCalledOnce();
      }
      database.db.exec("DROP TABLE transcript_events");
      expect(readTranscriptStatsBatchReadOnlySync(scopes)).toEqual(scopes.map(() => null));
      const absent = { ...scope, storePath: state.statePath("missing.sqlite") };
      expect(
        readTranscriptStatsBatchReadOnlySync(ids.map((sessionId) => ({ ...absent, sessionId }))),
      ).toEqual(ids.map(() => null));
      await expect(fs.stat(absent.storePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resolve.mockRestore();
    }
  });
});

it("reads only process-held incognito statistics and keeps each store's batch results separate", async () => {
  await withOpenClawTestState({ label: "stats-batch-incognito" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "private",
      sessionKey: "agent:main:dashboard:incognito-stats",
    };
    const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath(scope);
    const scopes = Array.from({ length: 11 }, (_, index) => ({
      ...scope,
      sessionId: index === 0 ? scope.sessionId : `missing-${index}`,
    }));
    expect(readTranscriptStatsBatchReadOnlySync(scopes)).toEqual(scopes.map(() => null));
    expect(isOpenClawAgentDatabaseOpen(incognitoPath)).toBe(false);
    await replaceTranscriptEvents(scope, [{ type: "session", id: scope.sessionId, version: 3 }]);
    const publicScope = { ...scope, sessionKey: "agent:main:public" };
    await replaceTranscriptEvents(publicScope, [
      { type: "session", id: scope.sessionId, version: 3 },
      { type: "message", message: { role: "user", content: "Public" } },
    ]);
    const expected = readTranscriptStatsSync(scope);
    const publicStats = readTranscriptStatsSync(publicScope);
    expect(expected.eventCount).toBe(1);
    expect(publicStats.eventCount).toBe(2);
    expect(readTranscriptStatsBatchReadOnlySync([publicScope, ...scopes, publicScope])).toEqual([
      publicStats,
      expected,
      ...scopes.slice(1).map(() => ({ eventCount: 0, maxSeq: 0, sizeBytes: 0 })),
      publicStats,
    ]);
    await expect(fs.stat(incognitoPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("restores once more when a peer archives between async preparation and the atomic read", async () => {
  await withRace("cold-async-read-race", async (race) => {
    let reads = 0;
    const result = await readRestoredSessionTranscript(race.scope, () => {
      if (++reads === 1) {
        race.commitArchive();
      }
      return loadTranscriptHeaderSync(race.scope);
    });
    expect(result).toMatchObject({ type: "session", id: race.scope.sessionId });
    expect(reads).toBe(2);
  });
});

it("retries Gateway visitation when a peer archives after async restoration", async () => {
  await withRace("cold-gateway-visitor-race", async (race) => {
    const visited: Array<{ message: unknown; seq: number }> = [];
    race.commitAfterMarkerRead();
    const count = await visitSessionMessagesAsync(
      { ...race.scope, storePath: race.database.path },
      (message, seq) => {
        expect(race.database.db.isTransaction).toBe(true);
        visited.push({ message, seq });
      },
    );
    expect(race.committed()).toBe(true);
    expect(count).toBe(2);
    expect(visited).toEqual([
      { message: { role: "user", content: "Original question" }, seq: 1 },
      { message: { role: "assistant", content: "Original answer" }, seq: 2 },
    ]);
    expect(race.database.db.isTransaction).toBe(false);
    expect(race.database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
      busy: 0,
    });
  });
});

it("copies one source snapshot when a peer archives during cross-store canonical repair", async () => {
  await withRace("cold-canonical-copy-snapshot", async (race, state) => {
    const destinationOptions = {
      agentId: "main",
      env: state.env,
      path: state.statePath("destination.sqlite"),
    };
    const entry = { sessionId: race.scope.sessionId, updatedAt: 1 };
    await replaceSessionEntry({ ...race.scope, storePath: destinationOptions.path }, entry);
    const original = race.database.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all();
    race.commitAfterMarkerRead();
    runOpenClawAgentWriteTransaction((destinationDatabase) => {
      copySqliteSessionOwnedStateForCanonicalRepair({
        canonicalKey: race.scope.sessionKey,
        destinationDatabase,
        source: { agentId: "main", storePath: race.database.path },
        sourceEntries: [entry],
        sourceKeys: [race.scope.sessionKey],
      });
    }, destinationOptions);
    expect(race.committed()).toBe(true);
    expect(
      openOpenClawAgentDatabase(destinationOptions)
        .db.prepare("SELECT * FROM transcript_events ORDER BY seq")
        .all(),
    ).toEqual(original);
  });
});

it("counts hot and cold transcripts in one snapshot while another connection archives", async () => {
  await withRace("cold-status-snapshot", async (race) => {
    race.commitAfterMarkerRead(
      (query) => query.includes('from "session_windows" as "window"') && query.includes("count(*)"),
    );
    expect(readSessionColdStorageInventory(race.database)).toEqual({
      hotTranscripts: 1,
      coldTranscripts: 0,
      embeddedArchiveBytes: 0,
    });
    expect(race.committed()).toBe(true);
    expect(readSessionColdStorageInventory(race.database)).toEqual({
      hotTranscripts: 0,
      coldTranscripts: 1,
      embeddedArchiveBytes: 0,
    });
  });
});
