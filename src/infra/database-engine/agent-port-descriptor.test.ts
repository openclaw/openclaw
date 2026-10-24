import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { memoryTextSearchSchema } from "../../../packages/memory-host-sdk/src/host/memory-search-schema.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION as currentVersion } from "../../state/openclaw-agent-db-contract.js";
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

it.each([21, currentVersion])(
  "migrates only the private v%s copy, retiring legacy usage partitions",
  async (version) => {
    const root = tempDirs.make("agent-port-migration-");
    const source = path.join(root, "source.sqlite"),
      copy = path.join(root, "private.sqlite");
    const descriptor = await loadAgentPortDescriptor();
    const historical = version === 21;
    const retained = historical
      ? [{ scope: "retained", key: "key", value_json: '{"value":1}' }]
      : [
          {
            scope: USAGE_COST_PARTITION_SCOPE,
            key: usageCostPartitionKey('session-"snow:雪', "2026-10-01"),
            value_json: '{"current":true}',
          },
          { scope: "talk-client-voice-sessions", key: "voice", value_json: '{"status":"closed"}' },
        ];
    {
      using db = openNodeSqliteDatabase(source);
      if (historical) {
        seedOpenClawAgentSchemaV21(db);
      } else {
        db.exec(
          descriptor.sqlite +
            `
      PRAGMA user_version = ${currentVersion};
      INSERT INTO schema_meta VALUES ('primary', 'agent', ${currentVersion}, 'main', NULL, 1, 1);
    `,
        );
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
