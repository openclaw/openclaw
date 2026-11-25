import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { parentPort, setEnvironmentData, threadId, workerData } from "node:worker_threads";
import { createConformanceWorker } from "../infra/database-engine/conformance.test-support.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import {
  captureSqliteDatabaseAdmissions,
  installSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
  type SqliteDatabaseAdmissions,
} from "../infra/sqlite-database-admission.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import { ensureStatePostgresFragment } from "../state/openclaw-state-db-engine.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import { queryTranscriptReadEntries, type TranscriptReadOptions } from "./store-read.js";
import { readTranscriptSessionEntries } from "./store-sqlite-read.js";
import {
  writeMeetingTranscriptSessionInDatabase,
  writeMeetingTranscriptSummaryInDatabase,
} from "./store-sqlite-write.js";

export type ChronologyProof = {
  threadId: number;
  list: string[];
  filtered: string[];
  invalidFilter: string[];
  pages: { selectors: string[]; hasMore: boolean }[];
  retainedInstant: unknown;
};

async function runChronologyHost(input: { path: string; connection: string }): Promise<void> {
  assert.equal(threadId, 0);
  const anchor = openNodeSqliteDatabase(input.path);
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => retireSqliteDatabaseAdmissionForPath(input.path));
  cleanup.defer(() => anchor.close());
  admitSqliteSchema(anchor);
  setEnvironmentData("openclaw.test.state.connection", input.connection);
  const url = new URL(import.meta.url);
  const worker = createConformanceWorker(
    url,
    {
      path: input.path,
      admissions: captureSqliteDatabaseAdmissions(undefined, { location: input.path }),
    },
    { connection: input.connection },
  );
  cleanup.defer(() => worker.terminate().then(() => undefined));
  worker.on("message", (message: ChronologyProof | { error: string } | { namespace: string }) => {
    process.send?.(message);
  });
  const [code] = await once(worker, "exit");
  assert.equal(code, 0, `Meeting chronology worker exited ${code}`);
}

const input: { path: string; admissions: SqliteDatabaseAdmissions } = workerData;
if (parentPort) {
  const port = parentPort;
  using cleanup = new DisposableStack();
  cleanup.defer(() => port.close());
  cleanup.defer(() => openClawStateDatabaseCache.closeOpenClawStateDatabaseForTest());
  try {
    installSqliteDatabaseAdmissions(input.admissions);
    const options = { path: input.path };
    const { db: postgresDb } = openOpenClawStateDatabase(options);
    assert(isPostgresSqlConnection(postgresDb));
    const facts = getPostgresPhysicalFacts(postgresDb);
    assert(facts);
    port.postMessage({ namespace: facts.namespace });
    let ensureStatements = 0;
    const statements = channel("openclaw.database.statement");
    const countStatement = () => ensureStatements++;
    statements.subscribe(countStatement);
    try {
      ensureStatePostgresFragment(postgresDb, "meeting_transcript_sessions");
      assert.throws(
        () => ensureStatePostgresFragment(postgresDb, "unknown_chronology_table"),
        /No PostgreSQL state fragment owns unknown_chronology_table/,
      );
    } finally {
      statements.unsubscribe(countStatement);
    }
    assert.equal(ensureStatements, 0, "eager schema ensure must not issue SQL");
    ensureMeetingTranscriptsSchema(options);
    const fixtures = [
      ["later", "later", "2024-01-02T00:00:00Z", 1704153600000],
      ["tie-a-offset", "tie-a", "2024-01-01T03:00:00+03:00", 1704067200000],
      ["tie-a-iso", "tie-a", "2024-01-01T00:00:00Z", 1704067200000],
      ["tie-b", "tie-b", "2023-12-31T19:00:00-05:00", 1704067200000],
      ["older", "older", "2023-12-31T23:00:00Z", 1704063600000],
      ["invalid-a", "invalid", "garbage-a", null],
      ["invalid-b", "invalid", "garbage-b", null],
    ] as const;
    const write = (
      [selector, sessionId, startedAt]: (typeof fixtures)[number],
      started_at_ms: number | null,
    ) =>
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          writeMeetingTranscriptSessionInDatabase(db, {
            session: { sessionId, startedAt },
            sessionValues: {
              started_at_ms,
              selector,
              export_key: selector,
              session_slug: selector,
              provider_id: "chronology-conformance",
              title: selector,
              source_json: '{"providerId":"chronology-conformance"}',
              stopped_at: null,
              metadata_json: null,
            },
            now: 1704240000000,
          }),
        options,
      );
    for (const fixture of fixtures) {
      assert.equal(write(fixture, fixture[3]).inserted, true);
    }
    // Metadata updates must retain the instant fixed by the original admission.
    assert.equal(write(fixtures[2], 0).inserted, false);
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        writeMeetingTranscriptSummaryInDatabase(
          db,
          { sessionId: fixtures[2][1], startedAt: fixtures[2][2] },
          {
            generated_at: null,
            summary_json: null,
            markdown: "Synthetic notes",
            utterance_count: 0,
          },
        ),
      options,
    );
    assert.deepEqual(
      readTranscriptSessionEntries(postgresDb)
        .filter((entry) => entry.hasSummary)
        .map((entry) => entry.selector),
      ["tie-a-iso"],
    );
    const page = (params: TranscriptReadOptions) => {
      const result = queryTranscriptReadEntries(postgresDb, params);
      return { selectors: result.entries.map((entry) => entry.selector), hasMore: result.hasMore };
    };
    port.postMessage({
      threadId,
      list: page({ limit: 20 }).selectors,
      filtered: page({
        startedAfter: "2024-01-01T00:00:00Z",
        startedBefore: "2024-01-02T00:00:00Z",
      }).selectors,
      invalidFilter: page({ startedAfter: "garbage" }).selectors,
      pages: [undefined, fixtures[2], fixtures[3], fixtures[5]].map((cursor) =>
        page({ limit: 2, after: cursor && { sessionId: cursor[1], startedAt: cursor[2] } }),
      ),
      retainedInstant: postgresDb
        .prepare("SELECT started_at_ms FROM meeting_transcript_sessions WHERE selector = ?")
        .get("tie-a-iso")?.started_at_ms,
    } satisfies ChronologyProof);
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.stack : String(error) });
  }
} else if (process.send) {
  process.once("message", (message: { path: string; connection: string }) => {
    void runChronologyHost(message)
      .catch((error: unknown) => {
        process.send?.({ error: error instanceof Error ? error.stack : String(error) });
      })
      .finally(() => process.disconnect?.());
  });
}
