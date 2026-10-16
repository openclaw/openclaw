import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { parentPort, setEnvironmentData, threadId, Worker, workerData } from "node:worker_threads";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
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
import { writeMeetingTranscriptSessionInDatabase } from "./store-sqlite-write.js";

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
  let worker: Worker | undefined;
  try {
    admitSqliteSchema(anchor);
    setEnvironmentData("openclaw.test.state.connection", input.connection);
    const url = new URL(import.meta.url);
    const activeWorker = new Worker(url, {
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
      workerData: {
        path: input.path,
        admissions: captureSqliteDatabaseAdmissions(undefined, { location: input.path }),
      },
    });
    worker = activeWorker;
    activeWorker.on(
      "message",
      (message: ChronologyProof | { error: string } | { namespace: string }) => {
        process.send?.(message);
      },
    );
    await new Promise<void>((resolve, reject) => {
      activeWorker.once("error", reject);
      activeWorker.once("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Meeting chronology worker exited ${code}`));
        }
      });
    });
  } finally {
    try {
      await worker?.terminate();
    } finally {
      try {
        anchor.close();
      } finally {
        retireSqliteDatabaseAdmissionForPath(input.path);
      }
    }
  }
}

const input: { path: string; admissions: SqliteDatabaseAdmissions } = workerData;
if (parentPort) {
  const port = parentPort;
  try {
    installSqliteDatabaseAdmissions(input.admissions);
    const options = { path: input.path };
    const database = openOpenClawStateDatabase(options);
    const postgresDb = database.db;
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
    const write = (fixture: (typeof fixtures)[number], startedAtMs: number | null) => {
      const [selector, sessionId, startedAt] = fixture;
      return runOpenClawStateWriteTransaction(
        ({ db }) =>
          writeMeetingTranscriptSessionInDatabase(db, {
            session: { sessionId, startedAt },
            sessionValues: {
              started_at_ms: startedAtMs,
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
    };
    for (const fixture of fixtures) {
      assert.equal(write(fixture, fixture[3]).inserted, true);
    }
    // Metadata updates must retain the instant fixed by the original admission.
    assert.equal(write(fixtures[2], 0).inserted, false);
    const page = (params: TranscriptReadOptions) => {
      const result = queryTranscriptReadEntries(postgresDb, params);
      return { selectors: result.entries.map((entry) => entry.selector), hasMore: result.hasMore };
    };
    const after = (fixture: (typeof fixtures)[number]) => ({
      sessionId: fixture[1],
      startedAt: fixture[2],
    });
    const proof: ChronologyProof = {
      threadId,
      list: page({ limit: 20 }).selectors,
      filtered: page({
        startedAfter: "2024-01-01T00:00:00Z",
        startedBefore: "2024-01-02T00:00:00Z",
      }).selectors,
      invalidFilter: page({ startedAfter: "garbage" }).selectors,
      pages: [
        page({ limit: 2 }),
        page({ limit: 2, after: after(fixtures[2]) }),
        page({ limit: 2, after: after(fixtures[3]) }),
        page({ limit: 2, after: after(fixtures[5]) }),
      ],
      retainedInstant: postgresDb
        .prepare("SELECT started_at_ms FROM meeting_transcript_sessions WHERE selector = ?")
        .get("tie-a-iso")?.started_at_ms,
    };
    port.postMessage(proof);
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.stack : String(error) });
  } finally {
    try {
      openClawStateDatabaseCache.closeOpenClawStateDatabaseForTest();
    } finally {
      port.close();
    }
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
