import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { decodeMemoryEmbedding } from "../../packages/memory-host-sdk/src/host/embedding-vector.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { collectErrorGraphCandidates, readErrorCauses } from "../infra/errors.js";
import { decodeUsageCostRollup } from "../infra/session-cost-usage-rollup-codec.js";
import { createSessionUsageRollupData } from "../infra/session-cost-usage-rollup.js";
import { resolveZstdCodec } from "../infra/zstd-codec.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "./openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import {
  assertCanonicalAgentPersistenceVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-read.js";
import {
  ensureOpenClawAgentDatabaseSchema,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import { withoutAgentMemberAccess } from "./openclaw-agent-member-access-schema.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-schema-history.js";
import {
  seedOpenClawAgentSchemaV22,
  OPENCLAW_AGENT_SCHEMA_V22_SQL,
} from "./openclaw-agent-schema-v22.test-support.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row as readRow,
  seedVersion,
} from "./schema-migration.test-support.js";

afterEach(() => vi.restoreAllMocks());

function readRows(db: DatabaseSync, sql: string, bigints = false) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(bigints);
  return statement.all();
}

function select(db: DatabaseSync, table: string, columns = "*", order = "rowid") {
  return readRows(db, `SELECT ${columns} FROM ${table} ORDER BY ${order}`);
}

function withHistoricalDatabase(
  run: (fixture: {
    db: DatabaseSync;
    pathname: string;
    env: NodeJS.ProcessEnv;
    event: string;
    migrate: () => void;
    publish: () => Promise<void>;
  }) => Promise<void>,
  encoding?: string,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async ({ path, env }) => {
    const pathname = path("legacy.sqlite");
    let event: string;
    {
      using seed = new DatabaseSync(pathname);
      if (encoding) {
        seed.exec(`PRAGMA encoding = '${encoding}'; PRAGMA journal_mode = WAL`);
      }
      seedOpenClawAgentSchemaV22(seed);
      ({ event } = seedHistoricalData(seed));
    }
    using db = new DatabaseSync(pathname);
    const migrateFixture = () =>
      ensureOpenClawAgentDatabaseSchema(db, { agentId: "main", path: pathname, env });
    await run({
      db,
      pathname,
      env,
      event,
      migrate: migrateFixture,
      publish: () => withAgentDatabaseMaintenanceLease({ env }, async () => migrateFixture()),
    });
  });
}

function seedHistoricalData(db: DatabaseSync) {
  const event = ` {"type":"message","id":"first","id":"second","parentId":null,"message":{"role":"assistant","content":${JSON.stringify("saffronquasar 雪🦞 ".repeat(1024))}}}\n`;
  db.exec(`
    INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at)
      VALUES('agent:main:history', 'hot', '{"sessionId":"hot","updatedAt":2}', 2);
    INSERT INTO session_windows(session_id, session_key, created_at, updated_at)
      VALUES('hot', 'agent:main:history', 1, 2), ('cold', 'agent:main:history', 1, 2);
    INSERT INTO transcript_rewrite_watermarks(session_id, generation, updated_at)
      VALUES('hot', 'original-generation', 2);
    UPDATE session_nodes SET entry_valid = 1 WHERE session_key = 'agent:main:history';
  `);
  const insert = db.prepare(
    "INSERT INTO transcript_events(rowid, session_id, seq, event_json, created_at) VALUES(?, 'hot', ?, ?, ?)",
  );
  insert.run(41, 7, event, 11);
  insert.run(52, 90, '{ "type": "custom", "data": "small 雪" }', 12);
  insert.run(63, 99, "{broken\0snow雪", 13);
  db.exec(`
    INSERT INTO transcript_event_identities(session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
      VALUES('hot', 'first', 7, 'message', NULL, 'original-idempotency', 11);
    INSERT INTO session_transcript_active_events(session_id, active_position, event_seq, message_position, context_eligible)
      VALUES('hot', 0, 7, 0, 1);
    INSERT INTO session_transcript_fts(rowid, text, session_id, message_id, role, timestamp)
      VALUES
        (-17, 'saffronquasar', 'hot', 'first', 'assistant', '2026-09-18'),
        (42, 'saffronquasar', 'cold', 'cold-message', 'user', '2026-09-17'),
        (83, 'saffronquasar', 'hot', 'first', 'assistant', '2026-09-19'),
        (9007199254740993, 'saffronquasar', 'hot', NULL, 'tool', '2026-09-20');
    INSERT INTO memory_index_sources(path, source, hash, mtime, size)
      VALUES('memory/note.md', 'memory', 'source-hash', 1.5, 42);
    INSERT INTO memory_index_chunks(rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES(17, 'chunk', 'memory/note.md', 'memory', 1, 3, 'chunk-hash', 'synthetic', 'saffronquasar memory', '[1.0000000000000002,0.1]', 19);
    INSERT INTO memory_index_chunk_provenance(chunk_id, origin_class, session_kind, observed_at, supersedes_key)
      VALUES('chunk', 'owner', 'interactive', 18, 'older-chunk');
    INSERT INTO memory_index_chunk_recall_metadata(chunk_id, importance, triggers, project_key)
      VALUES('chunk', 7, '["saffronquasar"]', 'project');
    INSERT INTO memory_embedding_cache(rowid, provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES(23, 'synthetic', 'model', 'provider-key', 'chunk-hash', '[1.0000000000000002,0.1]', 2, 20);
  `);
  const archive = Buffer.from('{"type":"message","id":"cold-message"}\n');
  const codec = resolveZstdCodec();
  if (!codec) {
    throw new Error("Cold transcript fixture requires Zstd support");
  }
  const compressedArchive = codec.compress(archive);
  db.prepare(`INSERT INTO session_transcript_cold_archives
    (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage, archive_blob)
    VALUES('cold', 'cold-generation', 'cold.jsonl.zst', ?, 1, ?, ?, 10, 21, 'sqlite', ?)`).run(
    sha256Hex(compressedArchive),
    archive.length,
    compressedArchive.length,
    compressedArchive,
  );
  const rollup = createSessionUsageRollupData();
  rollup.untimestamped.totals.totalTokens = 17;
  const usage = {
    version: 6,
    pricingFingerprint: "synthetic",
    checkpoint: {
      kind: "jsonl",
      parsedOffset: 7,
      observedSize: 7,
      observedMtimeMs: 1,
      device: 1,
      inode: 2,
      anchorHash: "anchor",
    },
    scannedAt: 10,
    parsedRecords: 1,
    countedRecords: 0,
    rollup,
  };
  db.prepare(
    "INSERT INTO cache_entries(scope, key, value_json, blob, expires_at, updated_at) VALUES('session-cost-usage-rollup-v2', 'usage', ?, NULL, NULL, 31)",
  ).run(JSON.stringify(usage));
  db.exec(`INSERT INTO session_transcript_index_state
    (session_id, indexed_seq, needs_rebuild, active_event_count, active_message_count, updated_at)
    VALUES ('hot', 99, 1, 1, 1, 101);`);
  seedDeployedFtsOwnership(db);
  return { event };
}

const dirtyV22Sessions = new Set(
  "hot missing-map partial dangling claimed misowned misowner".split(" "),
);

function seedDeployedFtsOwnership(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO session_windows(session_id, session_key, created_at, updated_at)
      SELECT value, 'agent:main:history', 1, 2 FROM json_each('["missing-map","partial","dangling","claimed","missing-state","clean-empty","misowned","misowner"]');
    INSERT INTO session_transcript_fts(rowid, text, session_id, message_id, role, timestamp)
      VALUES (201, 'saffronquasar', 'missing-map', 'missing', 'user', 1),
             (202, 'saffronquasar', 'partial', 'partial-a', 'user', 2),
             (203, 'saffronquasar', 'partial', 'partial-b', 'assistant', '2'),
             (204, 'saffronquasar', 'dangling', 'dangling', 'tool', NULL),
             (205, 'saffronquasar', 'claimed', 'claim', 'assistant', 3),
             (206, 'saffronquasar', 'missing-state', 'unindexed', 'user', 4),
             (207, 'saffronquasar', 'misowned', 'misowned', 'user', 5);
    INSERT INTO session_transcript_index_state
      (session_id, indexed_seq, needs_rebuild, active_event_count, active_message_count, fts_row_count, updated_at)
      VALUES ('cold', 10, 0, 1, 1, 1, 102),
             ('missing-map', 1, 0, 1, 1, 1, 103),
             ('partial', 2, 0, 2, 2, 2, 104),
             ('dangling', 1, 0, 1, 1, 1, 105),
             ('claimed', -1, 1, 0, 0, NULL, 8675309),
             ('clean-empty', -1, 0, 0, 0, 0, 106),
             ('misowned', 1, 0, 1, 1, 0, 107),
             ('misowner', -1, 0, 0, 0, 1, 108);
    UPDATE session_transcript_index_state SET needs_rebuild = 0, fts_row_count = NULL WHERE session_id = 'hot';
    INSERT INTO session_transcript_fts_rows(session_id, fts_rowid)
      VALUES ('hot', -17), ('cold', 42), ('partial', 202), ('dangling', 999), ('misowner', 207);
  `);
}

const preservedTables = `session_nodes session_canonical_validation_pending session_windows
  transcript_event_identities session_transcript_active_events transcript_rewrite_watermarks
  session_transcript_cold_archives session_transcript_fts memory_index_sources
  memory_index_chunk_provenance memory_index_chunk_recall_metadata memory_index_state`.split(/\s+/);

function legacySnapshot(db: DatabaseSync) {
  const ftsStorage = Object.fromEntries(
    [
      ["data", "rowid"],
      ["idx", "segid, term"],
      ["content", "rowid"],
      ["docsize", "rowid"],
      ["config", "k"],
    ].map(([suffix, order]) => [
      suffix,
      readRows(db, `SELECT * FROM session_transcript_fts_${suffix} ORDER BY ${order}`, true),
    ]),
  );
  return {
    schema: select(db, "sqlite_schema", "type, name, tbl_name, sql", "type, name"),
    version: db.prepare("PRAGMA user_version").get(),
    owner: select(db, "schema_meta", "*", "meta_key"),
    events: select(
      db,
      "transcript_events",
      "rowid, session_id, seq, hex(CAST(event_json AS BLOB)) AS bytes, created_at",
    ),
    chunks: select(db, "memory_index_chunks", "rowid, *"),
    vectors: select(db, "memory_embedding_cache", "rowid, *"),
    cache: select(db, "cache_entries", "*", "scope, key"),
    indexState: select(db, "session_transcript_index_state", "*", "session_id"),
    ftsMapping: db
      .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_transcript_fts_rows'")
      .get()
      ? readRows(db, "SELECT * FROM session_transcript_fts_rows ORDER BY rowid", true)
      : undefined,
    ftsStorage,
    fts: readRows(db, "SELECT rowid, * FROM session_transcript_fts ORDER BY rowid", true),
    matches: readRows(
      db,
      "SELECT rowid FROM session_transcript_fts WHERE session_transcript_fts MATCH 'saffronquasar' ORDER BY rank",
      true,
    ),
    preserved: Object.fromEntries(preservedTables.map((table) => [table, select(db, table)])),
  };
}

it("refuses a schema22 dependent view without changing storage", async () => {
  await withHistoricalDatabase(async ({ db, publish }) => {
    db.exec(
      "CREATE VIEW retained_fts_map AS SELECT fts_rowid, session_id FROM session_transcript_fts_rows",
    );
    const before = legacySnapshot(db);
    await expect(publish()).rejects.toThrow();
    expect(legacySnapshot(db)).toEqual(before);
  });
});

it("rolls back converted storage when the maintenance scope rejects publication", async () => {
  await withHistoricalDatabase(async ({ db, pathname, publish }) => {
    const scope = createOpenClawDatabaseMaintenanceScope();
    const refusal = new Error("Recovery backup coverage is no longer current");
    let reachedPublication = false;
    try {
      const before = legacySnapshot(db);
      scope.addAgentSchemaMigrationCheck((migration) => {
        if (
          migration.path === pathname &&
          db.prepare("PRAGMA user_version").get()?.user_version === OPENCLAW_AGENT_SCHEMA_VERSION
        ) {
          reachedPublication = true;
          throw refusal;
        }
      });
      await expect(scope.run(publish)).rejects.toBe(refusal);
      expect(reachedPublication).toBe(true);
      expect(legacySnapshot(db)).toEqual(before);
    } finally {
      await scope.close();
    }
  });
});

it.each(["UTF-8", "UTF-16le"] as const)(
  "atomically publishes all new formats from a genuine %s historical database",
  async (encoding) => {
    expect(sha256Hex(OPENCLAW_AGENT_SCHEMA_V22_SQL)).toBe(
      "23f2a1e85494a512bce3f32623aed2beaf4e82bbeeb4362f6cc33d5dd3b8a6ea",
    );
    await withHistoricalDatabase(async ({ db, pathname, event, publish, migrate }) => {
      const before = legacySnapshot(db);
      // These entries have no cold fields, start time, or optional references.
      const expectedPreserved = {
        ...before.preserved,
        session_windows: select(
          db,
          "session_windows",
          "*, NULL AS row_transcript_json, NULL AS row_transcript_updated_at",
        ),
        session_nodes: select(
          db,
          "session_nodes",
          "*, 0 AS snapshot_revision, NULL AS session_started_at, 0 AS has_optional_references, NULL AS archive_undo_marker",
        ),
      };
      using reader = new DatabaseSync(pathname, { readOnly: true });
      let observedPublication = false;
      const exec = db.exec.bind(db);
      const write = vi.spyOn(db, "exec").mockImplementation((sql) => {
        exec(sql);
        if (sql === `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`) {
          observedPublication = true;
          expect(legacySnapshot(reader)).toEqual(before);
        }
      });
      await publish();
      write.mockRestore();
      expect(observedPublication).toBe(true);
      const after = legacySnapshot(reader);
      expect(after.version).toEqual({ user_version: OPENCLAW_AGENT_SCHEMA_VERSION });
      expect(reader.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(reader.prepare("SELECT * FROM session_entry_snapshots").all()).toEqual([]);
      expect(after.preserved).toEqual(expectedPreserved);
      for (const field of ["fts", "ftsStorage", "matches"] as const) {
        expect(after[field]).toEqual(before[field]);
      }
      expect(after.ftsMapping).toEqual(
        before.fts.map((row) => ({
          id: row.rowid,
          session_id: row.session_id,
          message_id: row.message_id,
        })),
      );
      expect(after.indexState).toEqual(
        before.indexState.map((row) => {
          const { fts_row_count: _count, ...preserved } = row;
          return {
            ...preserved,
            needs_rebuild: dirtyV22Sessions.has(String(row.session_id)) ? 1 : row.needs_rebuild,
          };
        }),
      );
      const rows = select(
        reader,
        "transcript_events",
        "rowid, seq, event_json, event_zstd, event_utf8_bytes, hex(CAST(event_json AS BLOB)) AS bytes",
      );
      expect(rows.map((row) => [row.rowid, row.seq])).toEqual([
        [41, 7],
        [52, 90],
        [63, 99],
      ]);
      for (const [index, row] of rows.entries()) {
        if (row.event_zstd instanceof Uint8Array) {
          const codec = resolveZstdCodec();
          expect(codec).not.toBeNull();
          expect(
            codec!.decompress(row.event_zstd, Number(row.event_utf8_bytes)).toString("utf8"),
          ).toBe(event);
          expect(row.event_json).toBeNull();
        } else {
          expect(row.bytes).toBe(before.events[index]?.bytes);
        }
      }
      expect(rows[0]?.event_zstd instanceof Uint8Array).toBe(
        encoding === "UTF-8" && resolveZstdCodec() !== null,
      );
      const chunk = after.chunks.find((row) => row.id === "chunk")!;
      expect(chunk.chunk_rowid).toBe(17);
      const vector = after.vectors[0]!;
      expect(vector).toMatchObject({ rowid: 23, dims: 2, updated_at: 20 });
      for (const { embedding } of [chunk, vector]) {
        if (!(embedding instanceof Uint8Array)) {
          throw new Error("Expected binary vector");
        }
        expect(decodeMemoryEmbedding(embedding)).toEqual([1 + Number.EPSILON, 0.1]);
      }
      const cached = after.cache.find((row) => row.key === "usage")!;
      expect(cached).toMatchObject({ scope: "session-cost-usage-rollup-v3", updated_at: 31 });
      if (typeof cached.value_json !== "string" || !(cached.blob instanceof Uint8Array)) {
        throw new Error("Expected migrated usage envelope/body");
      }
      // Version-6 reports predate the current pricing rules, so readers rebuild them.
      expect(decodeUsageCostRollup(cached.value_json, "synthetic", cached.blob)).toBeUndefined();
      expect(reader.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      const migrated = legacySnapshot(db);
      migrate();
      expect(legacySnapshot(db)).toEqual(migrated);
    }, encoding);
  },
);

it("rolls every conversion back when maintenance authority is lost", async () => {
  await withHistoricalDatabase(async ({ db, env, migrate, publish }) => {
    const before = legacySnapshot(db);
    let reachedPublication = false;
    const migrating = withAgentDatabaseMaintenanceLease({ env }, async (maintenance) => {
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        exec(sql);
        if (sql === `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`) {
          reachedPublication = true;
          runOpenClawStateWriteTransaction(
            ({ db: shared }) => {
              shared
                .prepare("UPDATE state_leases SET expires_at = 0 WHERE scope = ? AND lease_key = ?")
                .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
            },
            { env },
          );
        }
      });
      try {
        migrate();
      } finally {
        vi.restoreAllMocks();
        if (reachedPublication) {
          expect(() => maintenance.assertOwned()).toThrowError(
            expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
          );
        }
      }
    });
    const rejection: unknown = await migrating.catch((error: unknown) => error);
    expect(
      collectErrorGraphCandidates(rejection, readErrorCauses).some(
        (error) =>
          error instanceof OpenClawStateLeaseError && error.code === "OPENCLAW_STATE_LEASE_LOST",
      ),
    ).toBe(true);
    expect(reachedPublication).toBe(true);
    expect(legacySnapshot(db)).toEqual(before);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    await publish();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

const insertNodes = `INSERT INTO session_nodes (session_key, current_session_id, updated_at, entry_json, archived_at)
  VALUES ('active', 'one', 1, '{ "sessionId": "one" }', NULL),
         ('archived', 'two', 2, '{ "sessionId": "two", "archivedAt": 2 }', 2)`;
const markerColumn = (db: DatabaseSync) =>
  readRow(
    db,
    "SELECT type, [notnull], dflt_value FROM pragma_table_info('session_nodes') WHERE name='archive_undo_marker'",
  );
const nodes = (db: DatabaseSync) => select(db, "session_nodes", "*", "session_key");
const archiveUndoFixture = migrationFixture({
  predecessor: 44,
  target: 45,
  scope: ["schema_meta", "session_nodes"],
  seed(db) {
    const predecessor = getOpenClawAgentMigrationSchema(44);
    // The exact v44 DDL from upstream main eee7a1bd, independent of the candidate's v45 definition.
    expect(sha256Hex(predecessor)).toBe(
      "8b4399730f3a96d1450de6aa72b44698a4acef4d9a04d1199556ffec719e3007",
    );
    db.exec(predecessor);
    seedVersion(db, 44);
    db.exec(
      `${insertNodes}; INSERT INTO session_members(session_key,identity_id,added_by,added_at,access) VALUES ('archived','reader','owner',1,'suggest'); INSERT INTO cache_entries (scope,key,blob,updated_at) VALUES ('unrelated','bytes',X'00FF',1); ANALYZE;`,
    );
  },
});

it("upgrades v44 under maintenance custody without issuing or rewriting existing rows", async () => {
  await archiveUndoFixture("archive-undo.sqlite", async ({ database: db, migrate }) => {
    const before = nodes(db);
    const witness = agentWitness(db);
    expect(markerColumn(db)).toBeUndefined();
    expect(() => assertCanonicalAgentPersistenceVersion(db, "archive-undo.sqlite")).toThrow(
      /schema version 44.*upgrade it to schema version 45/u,
    );
    expect(() => ensureOpenClawAgentSchema(db, "main", "archive-undo.sqlite", 45)).toThrow(
      /stopped-writer maintenance/u,
    );
    await migrate("rollback");
    expectVersion(db, 44);
    expect(markerColumn(db)).toBeUndefined();
    expect(nodes(db)).toEqual(before);
    // An equal-value UPDATE would also preserve the snapshot; reject any node DML.
    db.setAuthorizer((action, table) =>
      table === "session_nodes" &&
      (action === constants.SQLITE_UPDATE ||
        action === constants.SQLITE_INSERT ||
        action === constants.SQLITE_DELETE)
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    await migrate();
    expectVersion(db, 45);
    // The nullable marker keeps the v44 reader floor, matching the update preflight.
    expect(readExistingAgentSchemaMeta(db)?.minReader).toBe(44);
    expect(readRow(db, "SELECT access FROM session_members WHERE identity_id='reader'")).toEqual({
      access: "suggest",
    });
    expect(() => assertCanonicalAgentPersistenceVersion(db, "archive-undo.sqlite")).not.toThrow();
    expect(nodes(db)).toEqual(
      before.map((node) => Object.assign(node, { archive_undo_marker: null })),
    );
    expect(() => assertOpenClawMigrationWitnessPreserved(witness, agentWitness(db))).not.toThrow();
    db.exec("UPDATE session_members SET access='send' WHERE identity_id='reader'");
    expect(() => assertOpenClawMigrationWitnessPreserved(witness, agentWitness(db))).toThrow(
      /changed or lost retained database content: session_members/u,
    );
    db.exec("UPDATE session_members SET access='suggest' WHERE identity_id='reader'");
    db.exec(
      "UPDATE session_nodes SET archive_undo_marker = 'synthetic' WHERE session_key = 'archived'",
    );
    expect(() => assertOpenClawMigrationWitnessPreserved(witness, agentWitness(db))).toThrow(
      /changed or lost retained database content: session_nodes/u,
    );
  });
});

it("restores the pre-upgrade session rows and v44 shape without reverting unrelated writes", async () => {
  await archiveUndoFixture(
    "archive-undo-restore.sqlite",
    async ({ database: db, restore }) => {
      await restore(() => ({
        nodes: nodes(db),
        schema: readRow(db, "SELECT sql FROM sqlite_schema WHERE name='session_nodes'"),
        version: readRow(db, "PRAGMA user_version"),
        metadata: readRow(db, "SELECT * FROM schema_meta"),
      }));
    },
    "state",
  );
});

it("refuses the exact divergent preview v44 without changing its marker or payload", async () => {
  const preview = migrationFixture({
    predecessor: 44,
    target: 45,
    scope: ["schema_meta", "session_nodes"],
    seed(db) {
      const ddl = withoutAgentMemberAccess(getOpenClawAgentMigrationSchema(45));
      expect(sha256Hex(ddl)).toBe(
        "2a1ba60f141406d06be88e3ff45961501bade65c05b943d803c3eb935fe3e6e5",
      );
      db.exec(ddl);
      seedVersion(db, 44);
      db.exec(insertNodes);
      db.exec(
        "UPDATE session_nodes SET archive_undo_marker='preview' WHERE session_key='archived'",
      );
    },
  });
  await preview("archive-undo-preview.sqlite", async ({ database: db, migrate }) => {
    const before = nodes(db);
    await expect(migrate()).rejects.toThrow(/preview archive-marker schema 44 is unsupported/u);
    expectVersion(db, 44);
    expect(nodes(db)).toEqual(before);
  });
});

it("refuses a preexisting non-null archive verifier rather than adopting it on upgrade", async () => {
  await archiveUndoFixture("archive-undo-collision.sqlite", async ({ database: db, migrate }) => {
    db.exec(
      "ALTER TABLE session_nodes ADD COLUMN archive_undo_marker TEXT; UPDATE session_nodes SET archive_undo_marker='unissued' WHERE session_key='archived'",
    );
    const before = nodes(db);
    await expect(migrate()).rejects.toThrow(/archive undo marker predating schema 45/u);
    expectVersion(db, 44);
    expect(nodes(db)).toEqual(before);
  });
});
