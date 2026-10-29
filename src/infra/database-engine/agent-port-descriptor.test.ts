import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { memoryTextSearchSchema } from "../../../packages/memory-host-sdk/src/host/memory-search-schema.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  dumpGitBackupDatabase,
  restoreGitBackupDirectory,
} from "../../snapshot/git-backup-codec.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION as currentVersion } from "../../state/openclaw-agent-db-contract.js";
import { getOpenClawAgentMigrationSchema } from "../../state/openclaw-agent-db-schema-helpers.js";
import { seedOpenClawAgentSchemaV21 } from "../../state/openclaw-agent-schema-v21.test-support.js";
import { seedAgentV30Schema } from "../../state/schema-migration.test-support.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import {
  LEGACY_USAGE_COST_PARTITION_SCOPE,
  USAGE_COST_PARTITION_SCOPE,
  usageCostPartitionKey,
} from "../session-cost-usage-partitions.js";
import { loadAgentPortDescriptor } from "./agent-port-descriptor.js";
import { inspectDatabasePort, migrateDatabasePortSource } from "./port.worker.js";
import { admitStoreSearch } from "./search-admission.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const cacheRow = (scope: string, key: string, value_json: string) => ({ scope, key, value_json });

it("backs up a schema-36 store without requiring the later cold archive chunk table", async () => {
  const descriptor = await loadAgentPortDescriptor(36);
  using db = openNodeSqliteDatabase(":memory:");
  seedAgentV30Schema(db, 36);
  for (const table of ["sources", "chunks"]) {
    for (const event of ["insert", "update", "delete"]) {
      db.exec(`DROP TRIGGER memory_index_${table}_revision_after_${event}`);
    }
  }
  const inspected = await inspectDatabasePort({ engine: "sqlite", db }, descriptor);
  expect(inspected.tables.session_transcript_cold_archives?.rows).toBe(0);
  expect(inspected.tables.session_transcript_cold_archive_chunks).toBeUndefined();
  using restored = openNodeSqliteDatabase(":memory:");
  restored.exec(descriptor.sqlite);
  expect(
    restored
      .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
      .get("session_transcript_cold_archive_chunks"),
  ).toBeUndefined();
});

it("keeps the cold archive chunk table when backing up a schema-37 store", async () => {
  const descriptor = await loadAgentPortDescriptor(37);
  const table = "session_transcript_cold_archive_chunks";
  expect(descriptor.version).toBe(37);
  expect(descriptor.tables.map(({ name }) => name)).toContain(table);
  expect(descriptor.expectedCatalog.some((fact) => fact.table === table)).toBe(true);
  expect(descriptor.preData).toContain(`CREATE TABLE "${table}"`);
});

it.each([38, 39])(
  "restores the exact schema-%s progress layout without changing the source",
  async (version) => {
    const descriptor = await loadAgentPortDescriptor(version);
    const workColumns = [
      "display_kind",
      "work_json",
      "work_generation",
      "work_revision",
      "work_command_json",
    ];
    const table = descriptor.tables.find(({ name }) => name === "session_progress_cards")!;
    const columns = table.columns.map(({ name }) => name);
    expect(columns.filter((name) => workColumns.includes(name))).toEqual(
      version === 38 ? [] : workColumns,
    );
    const catalogColumns = descriptor.expectedCatalog
      .filter((fact) => fact.table === table.name && fact.kind === "column")
      .map((fact) => fact.value);
    expect(catalogColumns).toHaveLength(columns.length);
    for (const name of workColumns) {
      const matching = expect.arrayContaining([expect.objectContaining({ name })]);
      if (version === 39) {
        expect(catalogColumns).toEqual(matching);
      } else {
        expect(catalogColumns).not.toEqual(matching);
      }
    }
    for (const column of workColumns) {
      expect(descriptor.preData.includes(`"${column}"`)).toBe(version === 39);
    }
    const root = tempDirs.make("agent-port-history-");
    const source = path.join(root, "source.sqlite");
    const restored = path.join(root, "restored.sqlite");
    const exported = path.join(root, "export");
    const payload = ' {"retained":"雪","n":1} ';
    {
      using db = openNodeSqliteDatabase(source);
      db.exec(`${getOpenClawAgentMigrationSchema(version)}
      PRAGMA user_version = ${version};
      INSERT INTO schema_meta VALUES ('primary', 'agent', ${version}, 'main', NULL, 1, 1);`);
      db.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES ('retained', 'key', ?, 1)",
      ).run(payload);
      expect(
        db
          .prepare("PRAGMA table_info(session_progress_cards)")
          .all()
          .map((row) => row.name),
      ).toEqual(columns);
      expect(
        (await inspectDatabasePort({ engine: "sqlite", db }, descriptor)).tables.cache_entries
          ?.rows,
      ).toBe(1);
    }
    const before = await fs.readFile(source);
    await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: exported,
      identity: { role: "agent", agentId: "main" },
    });
    await restoreGitBackupDirectory({
      sourcePath: exported,
      targetPath: restored,
      expectedIdentity: { role: "agent", agentId: "main" },
    });
    {
      using db = openNodeSqliteDatabase(restored);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
      expect(
        db
          .prepare("PRAGMA table_info(session_progress_cards)")
          .all()
          .map((row) => row.name),
      ).toEqual(columns);
      expect(
        db.prepare("SELECT value_json FROM cache_entries WHERE scope = 'retained'").get()
          ?.value_json,
      ).toBe(payload);
      expect(
        (await inspectDatabasePort({ engine: "sqlite", db }, descriptor)).tables.cache_entries
          ?.rows,
      ).toBe(1);
    }
    if (version === 39) {
      await descriptor.admit!(restored);
    }
    expect(await fs.readFile(source)).toEqual(before);
  },
);

it("refuses an unsupported historical or future descriptor", async () => {
  await expect(loadAgentPortDescriptor(26)).rejects.toThrow(
    "Missing agent PostgreSQL backup descriptor",
  );
  await expect(loadAgentPortDescriptor(40)).rejects.toThrow(
    "Missing agent PostgreSQL backup descriptor",
  );
});

it.each([21, 38, currentVersion])(
  "migrates only the private v%s copy, retiring legacy usage partitions",
  async (version) => {
    const root = tempDirs.make("agent-port-migration-");
    const source = path.join(root, "source.sqlite"),
      copy = path.join(root, "private.sqlite");
    const descriptor = await loadAgentPortDescriptor();
    const historical = version !== currentVersion;
    const retained = historical
      ? [cacheRow("retained", "key", '{"value":1}')]
      : [
          cacheRow(
            USAGE_COST_PARTITION_SCOPE,
            usageCostPartitionKey('session-"snow:雪', "2026-10-01"),
            '{"current":true}',
          ),
          cacheRow("talk-client-voice-sessions", "voice", '{"status":"closed"}'),
        ];
    {
      using db = openNodeSqliteDatabase(source);
      if (version === 21) {
        seedOpenClawAgentSchemaV21(db);
      } else if (version === 38) {
        const previous = await loadAgentPortDescriptor(38);
        db.exec(`${previous.sqlite}
          PRAGMA user_version = 38;
          INSERT INTO schema_meta VALUES ('primary', 'agent', 38, 'main', NULL, 1, 1);`);
      } else {
        db.exec(`${descriptor.sqlite}
      PRAGMA user_version = ${currentVersion};
      INSERT INTO schema_meta VALUES ('primary', 'agent', ${currentVersion}, 'main', NULL, 1, 1);
    `);
      }
      const insert = db.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, 1)",
      );
      if (!historical) {
        for (const key of ["session\0date", "session\\u0000date"]) {
          insert.run(LEGACY_USAGE_COST_PARTITION_SCOPE, key, '{"retired":true}');
        }
      }
      for (const row of retained) {
        insert.run(row.scope, row.key, row.value_json);
      }
      expect(descriptor.inspectSqliteSource!(db).migrationRequired).toBe(true);
    }
    const before = await fs.readFile(source);
    await fs.copyFile(source, copy);
    const result = await migrateDatabasePortSource(copy, descriptor, version, () => {});
    expect(result.tables.cache_entries?.rows).toBe(retained.length);
    using migrated = openNodeSqliteDatabase(copy);
    expect(
      migrated.prepare("SELECT scope, key, value_json FROM cache_entries ORDER BY scope").all(),
    ).toEqual(retained);
    if (historical) {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(currentVersion);
    } else {
      expect(descriptor.inspectSqliteSource!(migrated).migrationRequired).toBe(false);
    }
    expect(await fs.readFile(source)).toEqual(before);
  },
);

it.each(["vector", "text"])("omits rebuildable %s indexes", async (kind) => {
  const descriptor = await loadAgentPortDescriptor();
  using db = openNodeSqliteDatabase(":memory:", { allowExtension: kind === "vector" });
  db.exec(descriptor.sqlite);
  if (kind === "vector") {
    expect(await loadSqliteVecExtension({ db })).toMatchObject({ ok: true });
    db.exec(
      "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3])",
    );
  } else {
    admitStoreSearch(db, memoryTextSearchSchema("unicode61"), { extension: "memory.text" });
  }
  const inspected = await inspectDatabasePort({ engine: "sqlite", db }, descriptor);
  const omitted =
    kind === "vector"
      ? /^memory_index_chunks_vec/
      : /^(memory_index_chunks_fts|memory_index_sources)$/;
  expect(Object.keys(inspected.tables).filter((table) => omitted.test(table))).toEqual([]);
});

it("preserves raw trajectories and refuses malformed compressed values", async () => {
  const decode = (await loadAgentPortDescriptor()).decodeSqlite!.trajectory_runtime_events!;
  const legacy = { session_id: "session", seq: 0, event_json: '{ "type": "legacy" }' };
  expect(decode(legacy)).toEqual(legacy);
  expect(() =>
    decode({ ...legacy, event_codec: "br", event_payload: "not a blob", event_utf8_bytes: 20 }),
  ).toThrow("Invalid compressed trajectory payload");
});
