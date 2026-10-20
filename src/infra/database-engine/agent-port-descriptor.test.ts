import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { memoryTextSearchSchema } from "../../../packages/memory-host-sdk/src/host/memory-search-schema.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { seedOpenClawAgentSchemaV21 } from "../../state/openclaw-agent-schema-v21.test-support.js";
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

it("retires only legacy usage partitions in the private current-schema port copy", async () => {
  const directory = tempDirs.make("agent-port-usage-cache-");
  const source = path.join(directory, "source.sqlite");
  const copy = path.join(directory, "private.sqlite");
  const descriptor = await loadAgentPortDescriptor();
  const currentKey = usageCostPartitionKey('session-"snow:雪', "2026-10-01");
  const retained = [
    { scope: USAGE_COST_PARTITION_SCOPE, key: currentKey, value_json: '{"current":true}' },
    { scope: "talk-client-voice-sessions", key: "voice", value_json: '{"status":"closed"}' },
  ];
  {
    using db = openNodeSqliteDatabase(source);
    db.exec(descriptor.sqlite);
    db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
      INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1)`);
    const insert = db.prepare(
      "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, 1)",
    );
    for (const key of ["session\0date", "session\\u0000date"]) {
      insert.run(LEGACY_USAGE_COST_PARTITION_SCOPE, key, '{"retired":true}');
    }
    for (const row of retained) {
      insert.run(row.scope, row.key, row.value_json);
    }
    expect(descriptor.inspectSqliteSource!(db).migrationRequired).toBe(true);
  }
  const before = await fs.readFile(source);
  await fs.copyFile(source, copy);
  const result = await migrateDatabasePortSource(
    copy,
    descriptor,
    OPENCLAW_AGENT_SCHEMA_VERSION,
    () => {},
  );
  expect(result.tables.cache_entries?.rows).toBe(2);
  using migrated = openNodeSqliteDatabase(copy);
  expect(
    migrated.prepare("SELECT scope, key, value_json FROM cache_entries ORDER BY scope").all(),
  ).toEqual(retained);
  expect(descriptor.inspectSqliteSource!(migrated).migrationRequired).toBe(false);
  expect(await fs.readFile(source)).toEqual(before);
});

it("omits the native vector accelerator and its auxiliary tables", async () => {
  const descriptor = await loadAgentPortDescriptor();
  using db = openNodeSqliteDatabase(":memory:", { allowExtension: true });
  db.exec(descriptor.sqlite);
  expect(await loadSqliteVecExtension({ db })).toMatchObject({ ok: true });
  db.exec(
    "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3])",
  );
  const inspected = await inspectDatabasePort({ engine: "sqlite", db }, descriptor);
  expect(
    Object.keys(inspected.tables).filter((table) => table.startsWith("memory_index_chunks_vec")),
  ).toEqual([]);
});

it("admits optional memory indexes but omits their rebuildable rows", async () => {
  const descriptor = await loadAgentPortDescriptor();
  using db = openNodeSqliteDatabase(":memory:");
  db.exec(descriptor.sqlite);
  admitStoreSearch(db, memoryTextSearchSchema("unicode61"), { extension: "memory.text" });
  const inspected = await inspectDatabasePort({ engine: "sqlite", db }, descriptor);
  expect(inspected.tables).not.toHaveProperty("memory_index_chunks_fts");
  expect(inspected.tables).not.toHaveProperty("memory_index_sources");
});

it("preserves historical raw trajectory rows and refuses malformed compressed port values", async () => {
  const descriptor = await loadAgentPortDescriptor();
  const decode = descriptor.decodeSqlite!.trajectory_runtime_events!;
  const legacy = { session_id: "session", seq: 0, event_json: '{ "type": "legacy" }' };
  expect(decode(legacy)).toEqual(legacy);
  expect(() =>
    decode({ ...legacy, event_codec: "br", event_payload: "not a blob", event_utf8_bytes: 20 }),
  ).toThrow("Invalid compressed trajectory payload");
});

it("migrates only the private historical agent copy before canonical verification", async () => {
  const directory = tempDirs.make("agent-port-migration-");
  const source = path.join(directory, "source.sqlite");
  const copy = path.join(directory, "private.sqlite");
  const descriptor = await loadAgentPortDescriptor();
  {
    using db = openNodeSqliteDatabase(source);
    seedOpenClawAgentSchemaV21(db);
    db.exec(
      "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES ('retained', 'key', '{\"value\":1}', 1)",
    );
    expect(descriptor.inspectSqliteSource!(db).migrationRequired).toBe(true);
  }
  const before = await fs.readFile(source);
  await fs.copyFile(source, copy);
  const result = await migrateDatabasePortSource(copy, descriptor, 21, () => {});
  expect(result.tables.cache_entries?.rows).toBe(1);
  using migrated = openNodeSqliteDatabase(copy);
  expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
    OPENCLAW_AGENT_SCHEMA_VERSION,
  );
  expect(migrated.prepare("SELECT value_json FROM cache_entries").get()?.value_json).toBe(
    '{"value":1}',
  );
  expect(await fs.readFile(source)).toEqual(before);
});
