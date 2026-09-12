import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { visitSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { copySqliteSessionOwnedStateForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import {
  createTranscriptIdentityReader,
  findTranscriptEventInDatabase,
  loadLatestAssistantText,
  loadTranscriptEventsFromDatabase,
  loadTranscriptEventRowsAfterSeqSync,
  loadTranscriptHeaderSync,
  loadTranscriptTailEventsSync,
  readTranscriptEventAtSeqSync,
  readTranscriptEventRows,
  readTranscriptStatsSync,
  readTranscriptStorageRows,
} from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import {
  getSessionColdStorageStatus,
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { searchSessionTranscripts } from "./session-transcript-search.js";

afterEach(() => vi.restoreAllMocks());

async function prepareRace(state: OpenClawTestState) {
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
  ) => {
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    const prepare = database.db.prepare.bind(database.db);
    vi.spyOn(database.db, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (!matches(query)) {
        return statement;
      }
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
        yield* iterate(...args);
        commitArchive();
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
const readers: Array<{ name: string; read: (race: Race) => unknown }> = [
  { name: "header", read: ({ scope }) => loadTranscriptHeaderSync(scope) },
  { name: "tail", read: ({ scope }) => loadTranscriptTailEventsSync(scope, 2) },
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
    await withOpenClawTestState({ label: "cold-read-snapshot" }, async (state) => {
      const race = await prepareRace(state);
      try {
        const original = read(race);
        expect(original).toBeDefined();
        race.commitAfterMarkerRead();
        expect(read(race)).toEqual(original);
        expect(race.committed()).toBe(true);
        expect(() => read(race)).toThrow(/cold storage/);
      } finally {
        vi.restoreAllMocks();
        race.writer.close();
      }
    });
  },
);

it("checks a cached identity reader when invoked after another connection archives", async () => {
  await withOpenClawTestState({ label: "cold-cached-identity" }, async (state) => {
    const race = await prepareRace(state);
    try {
      const read = createTranscriptIdentityReader(race.database, race.scope.sessionId);
      expect(read("user")).toMatchObject({ eventId: "user", seq: 1 });
      race.commitArchive();
      expect(() => read("user")).toThrow(/cold storage/);
    } finally {
      race.writer.close();
    }
  });
});

it.each(["stats", "search"] as const)(
  "keeps %s coherent when another connection archives",
  async (kind) => {
    await withOpenClawTestState({ label: "cold-metadata-snapshot" }, async (state) => {
      const race = await prepareRace(state);
      const read = () =>
        kind === "stats"
          ? readTranscriptStatsSync(race.scope)
          : searchSessionTranscripts({ ...race.scope, query: "Original" });
      try {
        const original = read();
        race.commitAfterMarkerRead();
        expect(read()).toEqual(original);
        expect(race.committed()).toBe(true);
        if (kind === "stats") {
          expect(read()).toEqual(original);
        } else {
          expect(read()).toMatchObject({ hits: [], archivedTranscriptsExcluded: 1 });
        }
      } finally {
        vi.restoreAllMocks();
        race.writer.close();
      }
    });
  },
);

it("restores once more when a peer archives between async preparation and the atomic read", async () => {
  await withOpenClawTestState({ label: "cold-async-read-race" }, async (state) => {
    const race = await prepareRace(state);
    try {
      let reads = 0;
      const result = await readRestoredSessionTranscript(race.scope, () => {
        if (++reads === 1) {
          race.commitArchive();
        }
        return loadTranscriptHeaderSync(race.scope);
      });
      expect(result).toMatchObject({ type: "session", id: race.scope.sessionId });
      expect(reads).toBe(2);
    } finally {
      race.writer.close();
    }
  });
});

it("retries Gateway visitation when a peer archives after async restoration", async () => {
  await withOpenClawTestState({ label: "cold-gateway-visitor-race" }, async (state) => {
    const race = await prepareRace(state);
    try {
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
    } finally {
      vi.restoreAllMocks();
      race.writer.close();
    }
  });
});

it("copies one source snapshot when a peer archives during cross-store canonical repair", async () => {
  await withOpenClawTestState({ label: "cold-canonical-copy-snapshot" }, async (state) => {
    const race = await prepareRace(state);
    const destinationOptions = {
      agentId: "main",
      env: state.env,
      path: state.path("destination.sqlite"),
    };
    const entry = { sessionId: race.scope.sessionId, updatedAt: 1 };
    await replaceSessionEntry({ ...race.scope, storePath: destinationOptions.path }, entry);
    const original = race.database.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all();
    try {
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
    } finally {
      vi.restoreAllMocks();
      race.writer.close();
    }
  });
});

it("counts hot and cold transcripts in one snapshot while another connection archives", async () => {
  await withOpenClawTestState({ label: "cold-status-snapshot" }, async (state) => {
    const race = await prepareRace(state);
    try {
      race.commitAfterMarkerRead(
        (query) =>
          query.includes('from "session_windows" as "window"') && query.includes("count(*)"),
      );
      const config = { agents: { entries: { main: { default: true } } } };
      expect(await getSessionColdStorageStatus(config)).toMatchObject([
        { hotTranscripts: 1, coldTranscripts: 0, embeddedArchiveBytes: 0 },
      ]);
      expect(race.committed()).toBe(true);
      expect(await getSessionColdStorageStatus(config)).toMatchObject([
        { hotTranscripts: 0, coldTranscripts: 1, embeddedArchiveBytes: 0 },
      ]);
    } finally {
      vi.restoreAllMocks();
      race.writer.close();
    }
  });
});
