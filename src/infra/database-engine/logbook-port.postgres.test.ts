import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import {
  exportPostgresBackup,
  restorePostgresBackup,
} from "../../snapshot/database-backup-core.worker.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { logbookPortProvider } from "./logbook-port.js";
import { admitDatabasePortDescriptor, type PortDescriptor } from "./port-descriptor.js";
import { sqliteDatabasePortProvider } from "./port-provider.js";
import { inspectDatabasePort, materializeDatabasePort } from "./port.worker.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const allocations = {
  "batches.id": { value: "70", called: true },
  "frames.id": { value: "110", called: true },
  "observations.id": { value: "130", called: true },
  "cards.id": { value: "170", called: true },
};

function rows(file: string, descriptor: PortDescriptor) {
  using db = openNodeSqliteDatabase(file, { readOnly: true, readBigInts: true });
  return descriptor.tables.map((table) => [
    table.name,
    db.prepare(`SELECT * FROM "${table.name}" ORDER BY "${table.pk[0]}"`).all(),
  ]);
}

const hash = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

describe.skipIf(!connection)("Logbook PostgreSQL port and exact backup", () => {
  let client: Client;
  let descriptor: PortDescriptor;
  let directory: string;
  let sourcePath: string;
  let framePath: string;
  const namespaces = new Set<string>();
  const storeId = randomUUID();
  const assertCurrent = () => {};

  beforeAll(async () => {
    directory = tempDirs.make("logbook-port-");
    sourcePath = path.join(directory, "logbook", "logbook.sqlite");
    framePath = path.join(directory, "logbook", "frames", "2026-07-03", "11.jpg");
    await fs.mkdir(path.dirname(framePath), { recursive: true });
    await fs.writeFile(framePath, Buffer.from([0, 255, 128, 1]));
    descriptor = await logbookPortProvider.loadDescriptor();
    client = new Client({ connectionString: connection });
    await client.connect();
    using db = openNodeSqliteDatabase(sourcePath);
    db.exec(descriptor.sqlite);
    db.exec(`PRAGMA user_version = 1;
      INSERT INTO batches (id, day, start_ms, end_ms, created_ms, updated_ms) VALUES
        (7, '2026-07-03', 1, 2, 1, 2), (70, '2026-07-03', 1, 2, 1, 2);
      INSERT INTO frames (id, captured_at_ms, day, path, content_hash, batch_id) VALUES
        (11, 1, '2026-07-03', 'placeholder', 'retained', 7),
        (110, 1, '2026-07-03', 'removed', 'removed', 70);
      INSERT INTO observations (id, batch_id, day, start_ms, end_ms, text) VALUES
        (13, 7, '2026-07-03', 1, 2, 'Retained observation'),
        (130, 70, '2026-07-03', 1, 2, 'Removed observation');
      INSERT INTO cards (id, day, start_ms, end_ms, title, summary, keyframe_id, updated_ms) VALUES
        (17, '2026-07-03', 1, 2, 'Retained card', 'Summary', 11, 2),
        (170, '2026-07-03', 1, 2, 'Removed card', 'Summary', 110, 2);
      INSERT INTO standups VALUES ('2026-07-03', 'Retained standup', 2);
      DELETE FROM cards WHERE id = 170;
      DELETE FROM observations WHERE id = 130;
      DELETE FROM frames WHERE id = 110;
      DELETE FROM batches WHERE id = 70;`);
    db.prepare("UPDATE frames SET path = ? WHERE id = 11").run(framePath);
    expect(sqliteDatabasePortProvider(db)).toBe(logbookPortProvider);
    expect(descriptor.inspectSqliteSource?.(db)).toEqual({
      version: 1,
      migrationRequired: false,
      pendingColumns: {},
    });
  });

  afterAll(async () => {
    try {
      for (const namespace of namespaces) {
        await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      }
    } finally {
      await client?.end();
    }
  });

  it("retains all allocation high-water marks, rows, and file references through port and backup", async () => {
    const snapshot = rows(sourcePath, descriptor);
    const sourceHash = await hash(sourcePath);
    const frameBytes = await fs.readFile(framePath);
    const namespace = `logbook_port_${randomUUID().replaceAll("-", "")}`;
    namespaces.add(namespace);
    let forward;
    {
      using source = openNodeSqliteDatabase(sourcePath, { readOnly: true, readBigInts: true });
      forward = await materializeDatabasePort({
        source: { engine: "sqlite", db: source },
        destination: { engine: "postgres", db: client, namespace },
        descriptor,
        storeId,
        assertCurrent,
      });
    }
    expect(forward.allocations).toEqual(allocations);
    const reversePath = path.join(directory, "reversed.sqlite");
    {
      using reverse = openNodeSqliteDatabase(reversePath, { readBigInts: true });
      expect(
        await materializeDatabasePort({
          source: { engine: "postgres", db: client, namespace },
          destination: { engine: "sqlite", db: reverse },
          descriptor,
          storeId,
          assertCurrent,
        }),
      ).toEqual(forward);
      expect(reverse.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all()).toEqual([
        { name: "batches", seq: 70n },
        { name: "cards", seq: 170n },
        { name: "frames", seq: 110n },
        { name: "observations", seq: 130n },
      ]);
    }
    expect(rows(reversePath, descriptor)).toEqual(snapshot);
    const backupDirectory = path.join(directory, "backup");
    await fs.mkdir(backupDirectory);
    {
      using anchor = openNodeSqliteDatabase(path.join(backupDirectory, "anchor.sqlite"));
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
      );
      anchor
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(storeId, namespace);
    }
    const admitted = await admitDatabasePortDescriptor(
      { engine: "postgres", db: client, namespace },
      descriptor,
    );
    const manifest = await exportPostgresBackup({
      client,
      descriptor: admitted,
      anchor: { engine: "postgres", storeId, namespace },
      sourcePath,
      directory: backupDirectory,
      profile: "exact",
      assertCurrent,
    });
    expect(manifest.source).toMatchObject({ owner: "logbook", schemaVersion: 1, storeId });
    expect(manifest.verification).toEqual(forward);
    expect(rows(path.join(backupDirectory, "database.sqlite"), descriptor)).toEqual(snapshot);
    const anchorPath = path.join(directory, "restored-anchor.sqlite");
    const restored = await restorePostgresBackup({
      client,
      descriptor,
      manifest,
      directory: backupDirectory,
      anchorPath,
      profile: "exact",
      assertCurrent,
    });
    namespaces.add(restored.namespace);
    const { tables, allocations: restoredAllocations } = await inspectDatabasePort(
      { engine: "postgres", db: client, namespace: restored.namespace },
      descriptor,
      storeId,
      true,
    );
    expect({ tables, allocations: restoredAllocations }).toEqual(forward);
    using anchor = openNodeSqliteDatabase(anchorPath);
    expect(anchor.prepare("SELECT * FROM openclaw_engine_anchor").get()).toEqual({
      engine: "postgres",
      store_id: storeId,
      schema: restored.namespace,
    });
    expect((await client.query(`SELECT path FROM "${restored.namespace}".frames`)).rows).toEqual([
      { path: framePath },
    ]);
    expect(await fs.readFile(framePath)).toEqual(frameBytes);
    expect(await hash(sourcePath)).toBe(sourceHash);
    // A deleted maximum remains allocated on both engines after the complete round trip.
    await client.query(`SET search_path = "${restored.namespace}"`);
    for (const [sql, id] of [
      [
        "INSERT INTO batches (day, start_ms, end_ms, created_ms, updated_ms) VALUES ('2026-07-03', 1, 2, 1, 2) RETURNING id",
        "71",
      ],
      [
        "INSERT INTO frames (captured_at_ms, day, path, content_hash) VALUES (1, '2026-07-03', 'next', 'next') RETURNING id",
        "111",
      ],
      [
        "INSERT INTO observations (batch_id, day, start_ms, end_ms, text) VALUES (7, '2026-07-03', 1, 2, 'Next') RETURNING id",
        "131",
      ],
      [
        "INSERT INTO cards (day, start_ms, end_ms, title, summary, updated_ms) VALUES ('2026-07-03', 1, 2, 'Next', 'Next', 2) RETURNING id",
        "171",
      ],
    ] as const) {
      expect((await client.query(sql)).rows).toEqual([{ id }]);
    }
  });

  it("registers the database for porting and frame artifacts for backup", () => {
    const config = { plugins: { entries: { logbook: { enabled: true } } } };
    const plugins = resolvePluginMetadataSnapshot({
      config,
      stateDir: directory,
      pluginIds: ["logbook"],
    });
    expect(plugins.plugins.find((plugin) => plugin.id === "logbook")?.backupResources).toEqual([
      { disposition: "include", scope: "state", relativePath: "logbook/frames" },
      { disposition: "include", scope: "state", relativePath: "logbook/logbook.sqlite" },
    ]);
    expect(
      logbookPortProvider.resolveRoots({ config, stateDir: directory, env: process.env, plugins }),
    ).toEqual([sourcePath]);
  });
});
