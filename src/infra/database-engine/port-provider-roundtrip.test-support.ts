import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";
import {
  fingerprintPostgresDatabase,
  restorePostgresBackup,
} from "../../snapshot/database-backup-core.worker.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { portBackupFixture } from "./port-backup.test-support.js";
import { fixtureDescriptor } from "./port-provider-fixture.test-support.js";
import { inspectDatabasePort, migrateDatabasePortSource } from "./port.worker.js";

export async function runProviderRoundtrip(client: Client, directory: string) {
  const scope = { assertCurrent: () => {} };
  const descriptor = fixtureDescriptor();
  const sourcePath = path.join(directory, "source.sqlite");
  const privatePath = path.join(directory, "private.sqlite");
  const fixture = portBackupFixture(client, directory, descriptor);
  const { namespace, storeId, postgres, query, file } = fixture;
  const started = performance.now();
  const hash = async (source: string) =>
    createHash("sha256")
      .update(await fs.readFile(source))
      .digest("hex");

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
  const migrated = await migrateDatabasePortSource(privatePath, descriptor, 1, scope.assertCurrent);
  assert.equal(await hash(sourcePath), original);
  {
    using db = openNodeSqliteDatabase(privatePath);
    assert.equal(db.prepare("SELECT edits FROM port_items").get()?.edits, 0);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
  }

  try {
    const staged = await fixture.forward(privatePath);
    assert.deepEqual(staged, migrated);
    assert.equal(staged.tables.port_items?.rows, 1);
    assert.equal(staged.tables.port_notes?.rows, 1);
    assert.equal(staged.tables.port_projection, undefined);
    assert.deepEqual(await query(`SELECT * FROM "${namespace}".port_projection`), [
      { id: "first", value: "RETAINED" },
    ]);

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
          inspectDatabasePort(postgres, descriptor, storeId),
          /Unknown PostgreSQL trigger or view/,
        );
      } finally {
        await client.query(drop);
      }
    }

    const manifest = await fixture.export(privatePath);
    assert.equal(manifest.source.owner, "synthetic");
    assert.deepEqual(manifest.activeFragments, ["labels", "notes"]);
    assert.deepEqual(manifest.verification, staged);
    const imageProbe = path.join(directory, "image-probe.sqlite");
    await fs.copyFile(file("backup/database.sqlite"), imageProbe);
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
      ...fixture.backup,
      manifest,
      anchorPath: restoredPath,
    };
    await assert.rejects(
      restorePostgresBackup({ ...restore, manifest: { ...manifest, activeFragments: ["labels"] } }),
      /Port source fragments differ from the recorded backup/,
    );
    const restored = await fixture.restore(manifest, restoredPath);
    {
      using db = openNodeSqliteDatabase(restoredPath);
      assert.deepEqual(
        { ...db.prepare("SELECT * FROM openclaw_engine_anchor").get() },
        { engine: "postgres", store_id: storeId, schema: restored.namespace },
      );
    }
    assert.deepEqual(await query(`SELECT * FROM "${restored.namespace}".port_notes`), [
      { id: "note", value: "note value" },
    ]);
    assert.deepEqual(await query(`SELECT * FROM "${restored.namespace}".port_projection`), [
      { id: "first", value: "RETAINED" },
    ]);
    const fingerprintInput = {
      client,
      descriptor,
      anchor: { engine: "postgres" as const, storeId, namespace: restored.namespace },
    };
    const fingerprint = await fingerprintPostgresDatabase(fingerprintInput);
    await client.query(
      `INSERT INTO "${restored.namespace}".port_items VALUES ('probe', 'probe', 0)`,
    );
    assert.deepEqual(
      await query(`SELECT edits FROM "${restored.namespace}".port_items WHERE id = 'probe'`),
      [{ edits: "1" }],
    );
    assert.notEqual(await fingerprintPostgresDatabase(fingerprintInput), fingerprint);
    assert.equal(await hash(sourcePath), original);
    return { total: Math.round(performance.now() - started) };
  } finally {
    await fixture.cleanup();
  }
}
