import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import * as maintenanceLease from "../state/openclaw-agent-db-maintenance-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as integrityWorker from "./sqlite-integrity-worker.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import { migrateLegacyMediaPersistence as migrate } from "./state-migrations.media-persistence.js";
import {
  cleanupMediaPersistenceFixtures,
  createEvent as makeEvent,
  createLegacyDatabaseFixture,
  PREVIOUS_VERSION,
  readDatabaseSnapshot,
  writeArchive,
  type FixtureEvent,
} from "./state-migrations.media-persistence.test-support.js";

const tempDirs: string[] = [];

afterEach(() => cleanupMediaPersistenceFixtures(tempDirs));

const mediaEnv = (prefix: string) => ({ OPENCLAW_STATE_DIR: makeTempDir(tempDirs, prefix) });
type EventOptions = Parameters<typeof makeEvent>[0];
function event(message: EventOptions["message"], options: Partial<EventOptions> = {}) {
  return makeEvent({ id: "event-1", parentId: null, timestamp: 1000, message, ...options });
}
type Events = Parameters<typeof createLegacyDatabaseFixture>[0]["eventsBySession"];
function fixture(eventsBySession: Events = {}, schemaVersion = PREVIOUS_VERSION, update = false) {
  const env = {
    ...mediaEnv("media-persistence-"),
    ...(update ? { OPENCLAW_UPDATE_IN_PROGRESS: "1" } : {}),
  };
  return {
    env,
    databasePath: createLegacyDatabaseFixture({ env, eventsBySession, schemaVersion }),
  };
}

const openDatabase = (pathname: string, readOnly = false) =>
  new (requireNodeSqlite().DatabaseSync)(pathname, { readOnly });
type Statement = ReturnType<DatabaseSync["prepare"]>;
function interceptStatements(visit: (db: DatabaseSync, sql: string, statement: Statement) => void) {
  const { DatabaseSync } = requireNodeSqlite();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to its original receiver below.
  const prepare = DatabaseSync.prototype.prepare;
  return vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    const statement = prepare.call(this, sql);
    visit(this, sql, statement);
    return statement;
  });
}
function readRows(pathname: string, statement: string) {
  using database = openDatabase(pathname, true);
  return database.prepare(statement).all();
}
async function migratePrepared(env: NodeJS.ProcessEnv) {
  let preparedPaths: string[] = [];
  const result = await migrate({
    env,
    onPreparedRepairTargets: (targets) => {
      preparedPaths = targets.map((target) => target.path);
    },
  });
  return { result, preparedPaths };
}

function insertTrajectory(
  database: DatabaseSync,
  events: string[],
  session = "session-a",
  time = 4000,
) {
  const insert = database.prepare(
    "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
  );
  events.forEach((json, seq) => insert.run(session, seq, "run-1", json, time + seq));
}

const archiveFile = (env: NodeJS.ProcessEnv, name: string) =>
  path.join(env.OPENCLAW_STATE_DIR!, "agents", "main", "sessions", name);
const trajectory = (messagesSnapshot: unknown[], rest = {}, type?: string) =>
  JSON.stringify({ type, data: { messagesSnapshot, ...rest } });
const trajectoryData = (json: string) =>
  (JSON.parse(json) as { data: { messagesSnapshot: Record<string, unknown>[] } }).data;
const messagesIn = (snapshot: ReturnType<typeof readDatabaseSnapshot>) =>
  snapshot.rows.map((row) => (JSON.parse(row.event_json) as FixtureEvent).message);

const media = (...entries: Record<string, unknown>[]) => ({
  __openclaw: { media: entries.map((entry) => expect.objectContaining(entry)) },
});
const expectNoMigration = async (env: NodeJS.ProcessEnv) =>
  expect(await migrate({ env })).toEqual({ changes: [], warnings: [] });

it.each([undefined, "full"] as const)("honors %s during pre-v17 media migration", async (mode) => {
  const message = { role: "user", content: "preserved", MediaPath: "/media/image.png" };
  const { env, databasePath: pathname } = fixture(
    { media: [event(message, { id: "kept", timestamp: 1 })] },
    16,
  );
  const before = readDatabaseSnapshot(pathname);
  const hostQueries: string[] = [];
  const sql = observeHostDataSql((query, database) => {
    if (database?.location() === pathname) {
      hostQueries.push(query);
    }
  });
  const checks = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
  try {
    const result = await migrate({ env, integrityCheck: mode });
    expect(result.warnings).toEqual([]);
    const after = readDatabaseSnapshot(pathname);
    expect(after.version.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(after.identities).toEqual(before.identities);
    expect(after.rows).toHaveLength(1);
    const migratedMessage = JSON.parse(after.rows[0]!.event_json).message;
    expect(migratedMessage).toMatchObject({
      content: message.content,
      __openclaw: { media: [{ path: message.MediaPath }] },
    });
    const requests = checks.mock.calls.filter(([file]) => file === pathname).map((call) => call[5]);
    expect([...new Set(requests.map((check) => check?.check))]).toEqual([mode ?? "quick"]);
    if (mode === "full") {
      expect(hostQueries.some((query) => /\bPRAGMA\s+quick_check\b/iu.test(query))).toBe(false);
    } else {
      expect(requests.some((check) => check?.tables?.includes("transcript_events"))).toBe(true);
      expect(
        hostQueries.filter((query) => /^PRAGMA\s+integrity_check\s*(?:;|$|\(\d)/iu.test(query)),
      ).toEqual([]);
    }
  } finally {
    checks.mockRestore();
    sql.restore();
  }
});

it("renews maintenance while a synchronous transcript scan outlasts its lease", async () => {
  const { env } = fixture(
    {
      slow: Array.from({ length: 65 }, (_, index) =>
        event({ role: "user" }, { id: `event-${index}`, timestamp: index + 1 }),
      ),
    },
    OPENCLAW_AGENT_SCHEMA_VERSION,
  );
  const originalLease = maintenanceLease.withAgentDatabaseMaintenanceLease;
  using _ = vi
    .spyOn(maintenanceLease, "withAgentDatabaseMaintenanceLease")
    .mockImplementation((options, run) => originalLease({ ...options, leaseMs: 3_000 }, run));
  using prepareSpy = interceptStatements((_database, sql, statement) => {
    if (sql.includes('from "transcript_events"') && sql.includes('as "event_json"')) {
      // Native payload hydration blocks the parent while its independent heartbeat renews.
      const delay = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 70);
      const all = statement.all.bind(statement);
      statement.all = () =>
        all().map((row) => {
          delay();
          return row;
        });
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (): Generator<Record<string, SQLOutputValue>, undefined> {
        for (const row of iterate()) {
          delay();
          yield row;
        }
        return undefined;
      };
    }
  });
  void prepareSpy;
  await expectNoMigration(env);
});

it("repairs the next agent after another agent loses maintenance ownership", async () => {
  const env = mediaEnv("media-persistence-agent-lease-loss-");
  const eventsBySession = {
    media: [event({ role: "user", MediaPath: "/media/image.png" }, { timestamp: 1 })],
  };
  const makeAgent = (agentId: string) =>
    createLegacyDatabaseFixture({
      env,
      agentId,
      eventsBySession,
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  const first = makeAgent("main");
  const second = makeAgent("small");
  const before = readDatabaseSnapshot(first);
  let revoked = false;
  using _ = interceptStatements((connection, sql, statement) => {
    if (connection.location() === first && sql.startsWith('update "transcript_events"')) {
      const run = statement.run.bind(statement);
      statement.run = new Proxy(run, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          if (revoked) {
            return result;
          }
          using database = openDatabase(resolveOpenClawStateSqlitePath(env));
          database.exec(
            "DELETE FROM state_leases WHERE scope = 'core:agent-database-maintenance' AND lease_key = 'global'",
          );
          revoked = true;
          return result;
        },
      });
    }
  });
  const { result, preparedPaths } = await migratePrepared(env);
  expect(revoked).toBe(true);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain(`Skipped agent database migration for ${first}:`);
  expect(result.warnings[0]).toContain("lease");
  expect(preparedPaths).toEqual([second]);
  expect(readDatabaseSnapshot(first)).toEqual(before);
  expect(result.changes).toContainEqual(
    expect.stringContaining(`Migrated media persistence in ${second}:`),
  );
  const snapshot = readDatabaseSnapshot(second);
  expect(messagesIn(snapshot)[0]).toMatchObject(media({ path: "/media/image.png" }));
});

it("converges pending same-version agent schema during an update", async () => {
  const { env, databasePath: pathname } = fixture({}, OPENCLAW_AGENT_SCHEMA_VERSION, true);
  {
    using database = openDatabase(pathname);
    database.exec("DROP TABLE session_reactions;");
  }
  await expectNoMigration(env);
  expect(
    readRows(pathname, "SELECT 1 FROM sqlite_schema WHERE name = 'session_reactions'"),
  ).toEqual([{ "1": 1 }]);
});

it("reports skipped embedding cache rows as recoverable Doctor warnings after a schema-21 upgrade", async () => {
  const { env, databasePath: pathname } = fixture({}, 21);
  {
    using database = openDatabase(pathname);
    database.exec(`INSERT INTO memory_embedding_cache
        (rowid, provider, model, provider_key, hash, embedding, dims, updated_at) VALUES
        (7, 'p', 'm', 'k', 'oversized', '[1]' || replace(hex(zeroblob(524288)), '0', ' '), 1, 1),
        (8, 'p', 'm', 'k', 'malformed', 'invalid', 1, 1),
        (9, 'p', 'm', 'k', 'valid', '[1]', 1, 1)`);
  }
  const result = await migrate({ env });
  expect(result).toMatchObject({
    warningDisposition: "recoverable",
    warnings: [expect.stringContaining("Skipped 2 memory_embedding_cache rows")],
  });
  expect(result.warnings[0]).toContain("7, 8");
  expect(readRows(pathname, "PRAGMA user_version")).toEqual([
    { user_version: OPENCLAW_AGENT_SCHEMA_VERSION },
  ]);
  expect(
    readRows(pathname, "SELECT rowid, typeof(embedding) AS storage FROM memory_embedding_cache"),
  ).toEqual([{ rowid: 9, storage: "blob" }]);
  await expectNoMigration(env);
});

it("retains a completed FULL schema crossing's integrity proof on reopen", async () => {
  const { env, databasePath: pathname } = fixture({}, 21, true);
  using checks = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
  const result = await migrate({ env, integrityCheck: "full" });
  expect(result.warnings).toEqual([]);
  expect(checks.mock.calls.filter(([file]) => file === pathname)).toHaveLength(1);
  using sql = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
  const reopened = openOpenClawAgentDatabase({ agentId: "main", env });
  expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
    OPENCLAW_AGENT_SCHEMA_VERSION,
  );
  expect(
    sql.mock.calls.filter(
      ([query], index) =>
        sql.mock.contexts[index] === reopened.db && /PRAGMA\s+integrity_check/iu.test(query),
    ),
  ).toEqual([]);
});

it("cancels pending integrity before migrating the agent schema", async () => {
  const { env, databasePath: pathname } = fixture({}, 21);
  const controller = new AbortController();
  const interruption = new Error("Doctor interrupted by SIGTERM");
  let entered!: () => void;
  const checking = new Promise<boolean>((resolve) => {
    entered = () => resolve(true);
  });
  using _ = vi
    .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
    .mockImplementation(async () => {
      entered();
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(interruption), {
          once: true,
        });
      });
    });
  const migration = withSqliteReadOnlyWorkerScope(() => migrate({ env }), {
    signal: controller.signal,
    deadlineOwnedByCaller: false,
  });
  try {
    expect(await Promise.race([checking, migration.then(() => false)])).toBe(true);
  } finally {
    controller.abort(interruption);
    await expect(migration).rejects.toBe(interruption);
  }
  expect(readRows(pathname, "PRAGMA user_version")).toEqual([{ user_version: 21 }]);
});

it("preserves the typed maintenance cause when lease acquisition fails", async () => {
  const { env } = fixture();
  closeOpenClawStateDatabaseForTest();
  const location = nodeSqlite.resolveExistingSqliteFileUri(resolveOpenClawStateSqlitePath(env));
  const originalOpen = nodeSqlite.openNodeSqliteDatabase;
  using _ = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((file, options) => {
    if (file === location && !options?.readOnly) {
      throw Object.assign(new Error("fixture lease storage failure"), { code: "SQLITE_IOERR" });
    }
    return originalOpen(file, options);
  });
  const result = await migrate({ env });
  expect(result).toMatchObject({
    changes: [],
    warnings: [expect.stringContaining("fixture lease storage failure | SQLITE_IOERR")],
  });
});

it("rewrites every active shape and trajectory snapshot, migrates mixed archives, and reruns as a no-op", async () => {
  const legacy = event(
    {
      role: "user",
      content: "legacy",
      idempotencyKey: "idem-legacy",
      MediaPaths: ["/media/a.ogg", "/media/b.png"],
      MediaTypes: ["audio", "image/png"],
      MediaTranscribedIndexes: [0],
      MediaWorkspaceDir: "/workspace",
    },
    { id: "event-legacy" },
  );
  const conflict = event(
    {
      role: "user",
      MediaPath: "/legacy.png",
      MediaType: "image/png",
      __openclaw: {
        traceId: "trace-1",
        media: [{ path: "/canonical.jpg", contentType: "image/jpeg" }],
      },
    },
    { id: "event-conflict", parentId: "event-legacy", timestamp: 2000 },
  );
  const { env, databasePath } = fixture({
    "session-a": [legacy, conflict],
    "session-b": [
      event(
        {
          role: "user",
          MediaPaths: ["", "/media/c.pdf"],
          MediaTypes: ["", "application/pdf"],
        },
        { id: "event-sparse", timestamp: 3000 },
      ),
    ],
  });
  const output = {
    modelOutput: "done",
    timing: { totalMs: 125 },
    toolTraces: [{ name: "read", durationMs: 5 }],
  };
  const emptyCarrierEventJson = trajectory(
    [{ role: "user", content: "empty", media: [], MediaPaths: [], MediaTypes: [] }],
    { modelOutput: "empty" },
    "model.completed",
  );
  {
    using database = openDatabase(databasePath);
    // Individually safe timestamps must not overflow an aggregate migration fingerprint.
    database
      .prepare("UPDATE transcript_events SET created_at = ?")
      .run(Math.floor(Number.MAX_SAFE_INTEGER / 2) + 100);
    insertTrajectory(database, [
      trajectory([legacy.message], output, "model.completed"),
      JSON.stringify({ data: { toolArguments: { MediaPath: "/not-a-message-field" } } }),
      trajectory([{ role: "user", media: [{ path: "/legacy-top-level.png" }] }]),
      emptyCarrierEventJson,
    ]);
  }

  const plainArchive = archiveFile(env, "cold-plain.jsonl.deleted.2026-07-24T01-02-03.000Z");
  const compressedArchive = `${archiveFile(
    env,
    "cold-zstd.jsonl.reset.2026-07-24T01-02-04.000Z",
  )}${SESSION_ARCHIVE_ZSTD_SUFFIX}`;
  writeArchive(plainArchive, [legacy], false);
  writeArchive(compressedArchive, [conflict], true);

  const before = readDatabaseSnapshot(databasePath);
  const sql = observeMainThreadSql();
  let result: Awaited<ReturnType<typeof migrate>>;
  try {
    const prepared = await migratePrepared(env);
    result = prepared.result;
    const { preparedPaths } = prepared;
    expect(preparedPaths).toEqual([databasePath]);
    const statements = sql.calls.flatMap((call) => call.mock.calls.map(([statement]) => statement));
    expect(
      statements.filter(
        (statement) =>
          typeof statement === "string" &&
          /\bsum\s*\(/iu.test(statement) &&
          /\b(?:transcript_events|trajectory_runtime_events)\b/iu.test(statement) &&
          !/\bwhere\b/iu.test(statement),
      ),
    ).toEqual([]);
  } finally {
    sql.restore();
  }
  expect(result.warnings).toEqual([]);
  expect(result.changes).toHaveLength(5);
  expect(result.changes).toEqual(
    expect.arrayContaining([
      `Upgraded agent database schema in ${databasePath}: v16 -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
      `Migrated media persistence in ${databasePath}: 2 transcript session(s), 2 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
      `Migrated archived transcript media in ${plainArchive}.`,
      `Migrated archived transcript media in ${compressedArchive}.`,
    ]),
  );

  const recoveryDirectories = () =>
    fs
      .readdirSync(path.dirname(databasePath))
      .filter((name) => name.startsWith("openclaw-media-persistence-recovery-"));
  const backups = recoveryDirectories();
  expect(backups).toHaveLength(1);
  const preserved = readDatabaseSnapshot(
    path.join(path.dirname(databasePath), backups[0]!, "database.sqlite"),
  );
  expect([preserved.rows, preserved.trajectoryRows]).toEqual([before.rows, before.trajectoryRows]);

  const after = readDatabaseSnapshot(databasePath);
  expect(after).toMatchObject({
    version: { user_version: OPENCLAW_AGENT_SCHEMA_VERSION },
    trajectoryCount: 4,
  });
  expect([after.identities, after.activeBranch, after.windows]).toEqual([
    before.identities,
    before.activeBranch,
    before.windows,
  ]);
  expect(after.trajectoryRows.map(({ event_json: _eventJson, ...row }) => row)).toEqual(
    before.trajectoryRows.map(({ event_json: _eventJson, ...row }) => row),
  );
  const migratedTrajectory = trajectoryData(after.trajectoryRows[0]!.event_json);
  expect(migratedTrajectory).toMatchObject(output);
  expect(migratedTrajectory.messagesSnapshot).toBeInstanceOf(Array);
  const migratedTrajectoryMessage = migratedTrajectory.messagesSnapshot[0];
  expect(migratedTrajectoryMessage).not.toHaveProperty("MediaPaths");
  expect(migratedTrajectoryMessage).toMatchObject(
    media({ path: "/media/a.ogg" }, { path: "/media/b.png" }),
  );
  expect(after.trajectoryRows[1]?.event_json).toBe(before.trajectoryRows[1]?.event_json);
  const topLevelMediaMessage = trajectoryData(after.trajectoryRows[2]!.event_json)
    .messagesSnapshot[0];
  expect(topLevelMediaMessage).not.toHaveProperty("media");
  expect(topLevelMediaMessage).toMatchObject(media({ path: "/legacy-top-level.png" }));
  expect(after.trajectoryRows[3]?.event_json).toBe(emptyCarrierEventJson);
  expect(after.rows.map((row) => row.created_at)).toEqual(before.rows.map((row) => row.created_at));
  expect(after.generations).not.toEqual(before.generations);
  const messages = messagesIn(after);
  expect(messages).toEqual([
    expect.objectContaining({
      role: "user",
      content: "legacy",
      idempotencyKey: "idem-legacy",
      ...media({ kind: "audio", transcribed: true }, { contentType: "image/png" }),
    }),
    expect.objectContaining({
      __openclaw: {
        traceId: "trace-1",
        media: [expect.objectContaining({ path: "/canonical.jpg" })],
      },
    }),
    expect.objectContaining({
      __openclaw: {
        media: [expect.any(Object), expect.objectContaining({ path: "/media/c.pdf" })],
      },
    }),
  ]);
  for (const message of messages) {
    expect(JSON.stringify(message)).not.toMatch(/"Media(?:Path|Paths|Type|Types|Url|Urls)/u);
  }
  expect(readSessionArchiveContentSync(plainArchive)).toContain('"__openclaw"');
  expect(readSessionArchiveContentSync(compressedArchive)).toContain('"__openclaw"');

  await appendTranscriptMessage(
    { agentId: "main", env, sessionId: "session-a", sessionKey: "agent:main:session-a" },
    {
      eventId: "current-writer",
      message: { role: "assistant", content: "after repair", MediaPath: "/media/new.png" },
    },
  );
  closeOpenClawAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  {
    using checks = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    using reads = vi.spyOn(DatabaseSync.prototype, "prepare");
    await expectNoMigration(env);
    expect(checks.mock.calls.filter(([pathname]) => pathname === databasePath)).toHaveLength(1);
    expect(
      reads.mock.calls.filter(
        ([query]) =>
          /from "(?:transcript_events|trajectory_runtime_events)"/u.test(query) &&
          query.includes('as "event_json"'),
      ),
    ).toEqual([]);
  }
  const appended = readDatabaseSnapshot(databasePath).rows.find(
    (row) => JSON.parse(row.event_json).id === "current-writer",
  );
  expect(recoveryDirectories()).toEqual(backups);
  expect(JSON.parse(appended!.event_json).message).toMatchObject({
    role: "assistant",
    content: "after repair",
    ...media({ path: "/media/new.png" }),
  });
});

it("defers current-schema media maintenance during updates and repairs it in explicit Doctor", async () => {
  const { env, databasePath } = fixture(
    {
      roles: [
        event({ role: "assistant", MediaPath: "/media/result.png" }, { id: "event-assistant" }),
        event(
          { MediaPath: "/media/imported.png" },
          {
            id: "event-roleless",
            parentId: "event-assistant",
            timestamp: 2000,
          },
        ),
      ],
    },
    OPENCLAW_AGENT_SCHEMA_VERSION,
  );

  const beforeUpdate = readDatabaseSnapshot(databasePath);
  {
    using checks = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    const { result, preparedPaths } = await migratePrepared({
      ...env,
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
    });
    expect(result).toEqual({ changes: [], warnings: [] });
    expect(readDatabaseSnapshot(databasePath)).toEqual(beforeUpdate);
    expect(preparedPaths).toEqual([databasePath]);
    expect(checks.mock.calls.filter(([pathname]) => pathname === databasePath)).toHaveLength(0);
  }

  const scope = createOpenClawDatabaseMaintenanceScope();
  scope.addAgentSchemaMigrationCheck(() => {
    throw new Error("Same-schema media cleanup must not require versioned backup coverage");
  });
  let result: Awaited<ReturnType<typeof migrate>>;
  try {
    result = await scope.run(() => migrate({ env }));
  } finally {
    await scope.close();
  }
  expect(result).toEqual({
    changes: [
      expect.stringMatching(/^Saved pre-repair SQLite backup: /),
      `Migrated media persistence in ${databasePath}: 1 transcript session(s), 0 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
    ],
    warnings: [],
  });
  const messages = messagesIn(readDatabaseSnapshot(databasePath));
  expect(messages).toEqual([
    expect.objectContaining({ role: "assistant", ...media({ path: "/media/result.png" }) }),
    expect.objectContaining(media({ path: "/media/imported.png" })),
  ]);
  for (const message of messages) {
    expect(message).not.toHaveProperty("MediaPath");
  }
  await expectNoMigration(env);
});

it.each([
  { schemaVersion: PREVIOUS_VERSION, kind: "transcript" },
  { schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION, kind: "trajectory" },
])(
  "rolls back late invalid $kind JSON at schema v$schemaVersion",
  async ({ schemaVersion, kind }) => {
    const { env, databasePath } = fixture(
      {
        corrupt: Array.from({ length: kind === "transcript" ? 65 : 1 }, (_, index) =>
          event(
            {
              role: "user",
              ...(index === 0 ? { MediaPath: "/media/a.png" } : {}),
            },
            {
              id: `event-${index}`,
              parentId: index === 0 ? null : `event-${index - 1}`,
              timestamp: 1000 + index,
            },
          ),
        ),
      },
      schemaVersion,
    );
    {
      using database = openDatabase(databasePath);
      if (kind === "transcript") {
        database
          .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 64")
          .run("{broken", "corrupt");
      } else {
        insertTrajectory(
          database,
          Array.from({ length: 65 }, (_, seq) =>
            seq === 64
              ? "{broken"
              : trajectory([{ role: "user", MediaPath: "/media/trajectory.png" }]),
          ),
          "corrupt",
          2000,
        );
      }
    }

    if (schemaVersion === PREVIOUS_VERSION) {
      expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
        "run openclaw doctor --fix to migrate persisted media",
      );
      closeOpenClawAgentDatabasesForTest();
    }
    const before = readDatabaseSnapshot(databasePath);
    const result = await migrate({ env });
    expect(result.warnings).toHaveLength(1);
    expect(result.changes).toEqual([
      expect.stringContaining(
        `Saved pre-repair SQLite backup: ${path.join(path.dirname(databasePath), "openclaw-media-persistence-recovery-")}`,
      ),
    ]);
    expect(result.warnings[0]).toContain(`Skipped agent database migration for ${databasePath}:`);
    expect(result.warnings[0]).toContain(`invalid ${kind} JSON`);
    expect(readDatabaseSnapshot(databasePath)).toEqual(before);
    expect(
      readRows(
        databasePath,
        "SELECT 1 FROM schema_meta WHERE meta_key = 'media-persistence-rows-v1'",
      ),
    ).toEqual([]);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual(
      schemaVersion === PREVIOUS_VERSION
        ? []
        : [expect.objectContaining({ path: databasePath, schemaVersion })],
    );
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ path: databasePath, schemaVersion })]);
  },
);

it("preserves an archive replaced before its atomic media repair", async () => {
  const row = event({ role: "user", MediaPath: "/media/a.png" });
  const { env } = fixture({ drift: [row] });
  const archivePath = archiveFile(env, "drift.jsonl.deleted.2026-07-24T01-02-03.000Z");
  writeArchive(archivePath, [row], false);
  const open = fs.openSync;
  using archiveOpen = vi.spyOn(fs, "openSync");
  archiveOpen.mockImplementation((candidate, flags, mode) => {
    if (flags === "wx" && String(candidate).startsWith(`${archivePath}.media-retirement.`)) {
      fs.writeFileSync(archivePath, "replacement\n");
    }
    return open(candidate, flags, mode);
  });
  const archiveDrift = await migrate({ env });
  expect(archiveDrift.warnings.join("\n")).toContain("changed before atomic");
  expect(fs.readFileSync(archivePath, "utf8")).toBe("replacement\n");
});
function createArchiveFixture(bytes: Uint8Array) {
  const stateDir = fs.realpathSync(makeTempDir(tempDirs, "media-persistence-archive-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawAgentDatabase({ agentId: "main", env });
  closeOpenClawAgentDatabasesForTest();
  const archivePath = archiveFile(env, "fixture.jsonl.deleted.2026-07-24T01-02-03.000Z");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, bytes);
  return { archivePath, env };
}

const valid = Buffer.from(`${JSON.stringify({ type: "event", id: "event-1" })}\n`);
it.each([
  ["removes a terminal NUL suffix atomically", Buffer.concat([valid, Buffer.alloc(284)]), "repair"],
  ["preserves an all-NUL file", Buffer.alloc(284), "reject"],
  ["preserves a blank record", Buffer.concat([valid, Buffer.from("\n")]), "reject"],
  ["does not rewrite an empty file", Buffer.alloc(0), "empty"],
] as const)("%s", async (_name, bytes, outcome) => {
  const { archivePath, env } = createArchiveFixture(bytes);
  const before = fs.lstatSync(archivePath);
  using rename = vi.spyOn(fs, "renameSync");
  const result = await migrate({ env });
  expect(rename.mock.calls.filter(([, destination]) => destination === archivePath)).toHaveLength(
    outcome === "repair" ? 1 : 0,
  );
  expect(fs.readFileSync(archivePath)).toEqual(outcome === "repair" ? valid : bytes);
  if (outcome === "repair") {
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(`Migrated archived transcript media in ${archivePath}.`);
  } else if (outcome === "reject") {
    expect(result).toMatchObject({
      warnings: [expect.stringContaining("Skipped archived transcript media migration")],
      warningDisposition: "recoverable",
    });
  } else {
    expect(result).toEqual({ changes: [], warnings: [] });
    const metadata = ({ dev, ino, mtimeMs, size }: fs.Stats) => ({ dev, ino, mtimeMs, size });
    expect(metadata(fs.lstatSync(archivePath))).toEqual(metadata(before));
  }
});
it("rejects ambiguous sparse arrays and ignores stale interrupted temp files", async () => {
  const { env } = fixture();
  const archivePath = archiveFile(env, "sparse.jsonl.bak.2026-07-24T01-02-03.000Z");
  const row = event({
    role: "user",
    MediaPaths: ["", "/media/b.png"],
    MediaTypes: ["image/png"],
  });
  writeArchive(archivePath, [row], false);
  expect((await migrate({ env })).warnings.join("\n")).toContain(
    "ambiguous sparse positional alignment",
  );
  fs.unlinkSync(archivePath);

  const corruptArchivePath = archiveFile(env, "corrupt.jsonl.deleted.2026-07-24T01-02-04.000Z");
  fs.writeFileSync(corruptArchivePath, "{broken\n");
  expect((await migrate({ env })).warnings.join("\n")).toContain("invalid transcript JSON");
  expect(fs.readFileSync(corruptArchivePath, "utf8")).toBe("{broken\n");
  fs.unlinkSync(corruptArchivePath);

  writeArchive(
    archivePath,
    [event({ role: "user", MediaPath: "/media/a.png", MediaType: "image/png" })],
    false,
  );
  fs.writeFileSync(`${archivePath}.media-retirement.999.interrupted.tmp`, "partial");
  expect((await migrate({ env })).changes.join("\n")).toContain(
    "Migrated archived transcript media",
  );
  expect(readSessionArchiveContentSync(archivePath)).toContain('"__openclaw"');
});
