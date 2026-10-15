import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";
import {
  exportPostgresBackup,
  fingerprintPostgresDatabase,
  restorePostgresBackup,
} from "../../snapshot/database-backup-core.worker.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitDatabasePortDescriptor } from "./port-descriptor.js";
import { fixtureDescriptor } from "./port-provider-fixture.test-support.js";
import {
  inspectDatabasePort,
  materializeDatabasePort,
  migrateDatabasePortSource,
} from "./port.worker.js";

export async function runProviderRoundtrip(client: Client, directory: string) {
  const scope = { assertCurrent: () => {} };
  const descriptor = fixtureDescriptor();
  const sourcePath = path.join(directory, "source.sqlite");
  const privatePath = path.join(directory, "private.sqlite");
  const namespace = `synthetic_${randomUUID().replaceAll("-", "")}`;
  const namespaces = new Set([namespace]);
  const storeId = randomUUID();
  const timings: Record<string, number> = {};
  const hash = async (file: string) =>
    createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
  async function timed<T>(phase: string, run: () => Promise<T>) {
    const start = performance.now();
    try {
      return await run();
    } finally {
      timings[phase] = Math.round(performance.now() - start);
    }
  }

  // The one source exercises the owner migration on its private copy.
  {
    using db = openNodeSqliteDatabase(sourcePath);
    db.exec(
      descriptor.sqlite
        .replace(", edits INTEGER NOT NULL", "")
        .replace(descriptor.triggers![0]!.sql, ""),
    );
    for (const fragment of descriptor.fragments ?? []) {
      db.exec(fragment.sqlite);
    }
    db.exec(
      "PRAGMA user_version = 1; INSERT INTO port_items VALUES ('first', 'retained'); INSERT INTO port_labels VALUES ('label', 'label value'); INSERT INTO port_notes VALUES ('note', 'note value'); INSERT INTO port_projection VALUES ('wrong', 'stale projection')",
    );
    db.exec(descriptor.triggers![0]!.sql);
  }
  const original = await hash(sourcePath);
  await fs.copyFile(sourcePath, privatePath);
  const migrated = await timed("private migration", () =>
    migrateDatabasePortSource(privatePath, descriptor, 1, scope.assertCurrent),
  );
  assert.equal(await hash(sourcePath), original);
  {
    using db = openNodeSqliteDatabase(privatePath);
    assert.equal(db.prepare("SELECT edits FROM port_items").get()?.edits, 0);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
  }

  try {
    const staged = await timed("SQLite to PostgreSQL", async () => {
      using source = openNodeSqliteDatabase(privatePath, { readOnly: true, readBigInts: true });
      return await materializeDatabasePort({
        source: { engine: "sqlite", db: source },
        destination: { engine: "postgres", db: client, namespace },
        descriptor,
        storeId,
        ...scope,
      });
    });
    assert.deepEqual(staged, migrated);
    assert.equal(staged.tables.port_items?.rows, 1);
    assert.equal(staged.tables.port_notes?.rows, 1);
    assert.equal(staged.tables.port_projection, undefined);
    assert.deepEqual((await client.query(`SELECT * FROM "${namespace}".port_projection`)).rows, [
      { id: "first", value: "RETAINED" },
    ]);

    await timed("PostgreSQL catalog refusals", async () => {
      for (const [create, drop] of [
        [
          `CREATE VIEW "${namespace}".surprise AS SELECT id FROM "${namespace}".port_items`,
          `DROP VIEW "${namespace}".surprise`,
        ],
        [
          `CREATE TRIGGER surprise BEFORE INSERT ON "${namespace}".port_items FOR EACH ROW EXECUTE FUNCTION "${namespace}".port_item_edits_fn()`,
          `DROP TRIGGER surprise ON "${namespace}".port_items`,
        ],
        [
          `CREATE TRIGGER port_item_edits BEFORE INSERT ON "${namespace}".port_projection FOR EACH ROW EXECUTE FUNCTION "${namespace}".port_item_edits_fn()`,
          `DROP TRIGGER port_item_edits ON "${namespace}".port_projection`,
        ],
      ] as const) {
        await client.query(create);
        try {
          await assert.rejects(
            inspectDatabasePort({ engine: "postgres", db: client, namespace }, descriptor, storeId),
            /Unknown PostgreSQL trigger or view/,
          );
        } finally {
          await client.query(drop);
        }
      }
    });

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
    const anchor = { engine: "postgres" as const, storeId, namespace };
    const admitted = await admitDatabasePortDescriptor(
      { engine: "postgres", db: client, namespace },
      descriptor,
    );
    const manifest = await timed("backup and PostgreSQL to SQLite", () =>
      exportPostgresBackup({
        client,
        descriptor: admitted,
        anchor,
        sourcePath: privatePath,
        directory: backupDirectory,
        profile: "exact",
        ...scope,
      }),
    );
    assert.equal(manifest.source.owner, "synthetic");
    assert.deepEqual(manifest.activeFragments, ["labels", "notes"]);
    assert.deepEqual(manifest.verification, staged);
    const imageProbe = path.join(directory, "image-probe.sqlite");
    await fs.copyFile(path.join(backupDirectory, "database.sqlite"), imageProbe);
    {
      using db = openNodeSqliteDatabase(imageProbe);
      assert.deepEqual(
        { ...db.prepare("SELECT * FROM port_items").get() },
        { id: "first", value: "retained", edits: 0 },
      );
      assert.deepEqual(
        { ...db.prepare("SELECT * FROM port_projection").get() },
        { id: "first", value: "RETAINED" },
      );
      assert.equal(db.prepare("SELECT value FROM port_labels").get()?.value, "label value");
      assert.equal(db.prepare("SELECT value FROM port_notes").get()?.value, "note value");
      db.exec("INSERT INTO port_items VALUES ('probe', 'probe', 0)");
      assert.equal(db.prepare("SELECT edits FROM port_items WHERE id = 'probe'").get()?.edits, 1);
    }

    const restoredPath = path.join(directory, "restored-anchor.sqlite");
    const restore = {
      client,
      descriptor,
      manifest,
      directory: backupDirectory,
      anchorPath: restoredPath,
      profile: "exact" as const,
      ...scope,
    };
    await assert.rejects(
      restorePostgresBackup({ ...restore, manifest: { ...manifest, activeFragments: ["labels"] } }),
      /Port source fragments differ from the recorded backup/,
    );
    const restored = await timed("restore", () => restorePostgresBackup(restore));
    namespaces.add(restored.namespace);
    {
      using db = openNodeSqliteDatabase(restoredPath);
      assert.deepEqual(
        { ...db.prepare("SELECT * FROM openclaw_engine_anchor").get() },
        { engine: "postgres", store_id: storeId, schema: restored.namespace },
      );
    }
    assert.deepEqual(
      (await client.query(`SELECT * FROM "${restored.namespace}".port_notes`)).rows,
      [{ id: "note", value: "note value" }],
    );
    assert.deepEqual(
      (await client.query(`SELECT * FROM "${restored.namespace}".port_projection`)).rows,
      [{ id: "first", value: "RETAINED" }],
    );
    const fingerprintInput = {
      client,
      descriptor,
      anchor: { ...anchor, namespace: restored.namespace },
    };
    const fingerprint = await timed("fingerprint before write", () =>
      fingerprintPostgresDatabase(fingerprintInput),
    );
    await client.query(
      `INSERT INTO "${restored.namespace}".port_items VALUES ('probe', 'probe', 0)`,
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT edits FROM "${restored.namespace}".port_items WHERE id = 'probe'`,
        )
      ).rows,
      [{ edits: "1" }],
    );
    assert.notEqual(
      await timed("fingerprint after write", () => fingerprintPostgresDatabase(fingerprintInput)),
      fingerprint,
    );
    assert.equal(await hash(sourcePath), original);
    return timings;
  } finally {
    for (const owned of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${owned}" CASCADE`);
    }
  }
}
