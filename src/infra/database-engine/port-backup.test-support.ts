import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Client } from "pg";
import {
  exportPostgresBackup,
  restorePostgresBackup,
} from "../../snapshot/database-backup-core.worker.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../sqlite-schema-facts.js";
import { openEngineStore } from "./open.js";
import {
  admitDatabasePortDescriptor,
  type PortDescriptor,
  type PortEndpoint,
} from "./port-descriptor.js";
import { inspectDatabasePort, materializeDatabasePort } from "./port.worker.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

export async function workboardPortFixture(canonicalSqlite = false) {
  const root = new URL("../../../extensions/workboard/src/", import.meta.url);
  const postgres = await fs.readFile(new URL("workboard-schema.postgres.sql", root), "utf8");
  const sqlite = canonicalSqlite
    ? (await fs.readFile(new URL("workboard-schema.ts", root), "utf8")).match(
        /WORKBOARD_SCHEMA_SQL = `([\s\S]*?)`;/,
      )?.[1]
    : metadata.sqlite;
  assert(sqlite, "The workboard owner must provide its canonical SQLite schema");
  const descriptor: PortDescriptor = {
    ...metadata,
    sqlite,
    preData: postgres.slice(metadata.preData[0], metadata.preData[1]),
    postData: postgres.slice(metadata.postData[0], metadata.postData[1]),
    expectedCatalog: expectedPostgresCatalog(metadata),
  };
  return { postgres, descriptor };
}

export function openPortStore(
  anchor: DatabaseSync,
  schema: Parameters<typeof openEngineStore>[0]["schema"],
  input: Parameters<typeof openEngineStore>[0]["input"],
  existingOnly = false,
) {
  return openEngineStore({
    anchor,
    schema,
    input,
    existingOnly,
    prepareAnchor() {},
    openSqlite() {
      throw new Error("Ported PostgreSQL store must not open SQLite data");
    },
    inspectSqlite() {
      admitSqliteSchema(anchor);
      const facts = getAdmittedSqliteSchemaFacts(anchor);
      assert(facts);
      return {
        hasExistingData: [...facts.tables].some(
          (name) => name !== "openclaw_engine_anchor" && !name.startsWith("sqlite_"),
        ),
        hasEngineAnchor: facts.tables.has("openclaw_engine_anchor"),
      };
    },
  });
}

export function writePortAnchor(file: string, storeId: string, namespace: string, checked = false) {
  using db = openNodeSqliteDatabase(file);
  db.exec(`CREATE TABLE openclaw_engine_anchor (
    store_id TEXT NOT NULL, engine TEXT NOT NULL ${checked ? "CHECK (engine = 'postgres')" : ""}, schema TEXT NOT NULL)`);
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(
    storeId,
    namespace,
  );
}

export function portBackupFixture(client: Client, directory: string, descriptor: PortDescriptor) {
  const storeId = randomUUID();
  const namespace = `port_${randomUUID().replaceAll("-", "")}`;
  const namespaces = new Set([namespace]);
  const file = (name: string) => path.join(directory, name);
  const postgres = { engine: "postgres" as const, db: client, namespace };
  const common = { descriptor, storeId, assertCurrent() {} };
  const backup = { client, directory: file("backup"), profile: "exact" as const, ...common };
  const port = (source: PortEndpoint, destination: PortEndpoint) =>
    materializeDatabasePort({ source, destination, ...common });
  return {
    storeId,
    namespace,
    file,
    postgres,
    backup,
    query: async (sql: string) => (await client.query(sql)).rows,
    async forward(sourcePath: string) {
      using db = openNodeSqliteDatabase(sourcePath, { readOnly: true, readBigInts: true });
      return await port({ engine: "sqlite", db }, postgres);
    },
    reverse: (db: DatabaseSync) => port(postgres, { engine: "sqlite", db }),
    inspect: (ns = namespace, verifyDefinitions = false) =>
      inspectDatabasePort({ ...postgres, namespace: ns }, descriptor, storeId, verifyDefinitions),
    async export(sourcePath: string) {
      await fs.mkdir(backup.directory);
      writePortAnchor(file("backup/anchor.sqlite"), storeId, namespace);
      return exportPostgresBackup({
        ...backup,
        descriptor: await admitDatabasePortDescriptor(postgres, descriptor),
        anchor: { engine: "postgres", storeId, namespace },
        sourcePath,
      });
    },
    async restore(manifest: Awaited<ReturnType<typeof exportPostgresBackup>>, anchorPath: string) {
      const restored = await restorePostgresBackup({ ...backup, manifest, anchorPath });
      namespaces.add(restored.namespace);
      return restored;
    },
    async cleanup() {
      for (const ns of namespaces) {
        await client.query(`DROP SCHEMA IF EXISTS "${ns}" CASCADE`);
      }
    },
  };
}
