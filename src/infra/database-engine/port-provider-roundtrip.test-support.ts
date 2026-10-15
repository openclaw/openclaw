import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import {
  capturePostgresBackup,
  fingerprintPostgresBackup,
  preparePostgresRestore,
  readBackupEngine,
} from "../../snapshot/database-backup.js";
import { SNAPSHOT_MANIFEST_FILENAME } from "../../snapshot/snapshot-provider.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { runDatabasePortTask } from "./port-command.worker.js";
import { fixtureDescriptor } from "./port-provider-fixture.test-support.js";
import { withDatabasePortPostgres } from "./port-provider.js";
import { inspectDatabasePort, materializeDatabasePort } from "./port.worker.js";

let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
}
const { connection, directory } = JSON.parse(input) as { connection: string; directory: string };
const config = { database: { engine: "postgres" as const, postgres: { connection } } };
const scope = { assertCurrent() {} };
const descriptor = fixtureDescriptor();
const sourcePath = path.join(directory, "source.sqlite");
const anchorPath = path.join(directory, "anchor.sqlite");
const namespace = `synthetic_${randomUUID().replaceAll("-", "")}`;
const namespaces = new Set([namespace]);
const storeId = randomUUID();
const hash = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

function seed(file: string) {
  using db = openNodeSqliteDatabase(file);
  db.exec(descriptor.sqlite);
  for (const fragment of descriptor.fragments ?? []) {
    db.exec(fragment.sqlite);
  }
  db.exec(
    "PRAGMA user_version = 2; INSERT INTO port_items VALUES ('first', 'retained', 6); INSERT INTO port_labels VALUES ('label', 'label value'); INSERT INTO port_notes VALUES ('note', 'note value'); INSERT INTO port_projection VALUES ('wrong', 'stale projection')",
  );
}

function expectImage(file: string) {
  using db = openNodeSqliteDatabase(file);
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM port_items").get() },
    { id: "first", value: "retained", edits: 7 },
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

seed(sourcePath);
const original = await hash(sourcePath);
for (const [name, sql, error] of [
  ["dependency", "DROP TABLE port_labels", /requires missing fragment labels/],
  [
    "trigger",
    "CREATE TRIGGER surprise AFTER INSERT ON port_items BEGIN SELECT 1; END",
    /Unknown SQLite table, trigger or view/,
  ],
  [
    "view",
    "CREATE VIEW surprise AS SELECT * FROM port_items",
    /Unknown SQLite table, trigger or view/,
  ],
] as const) {
  const file = path.join(directory, `${name}.sqlite`);
  await fs.copyFile(sourcePath, file);
  using db = openNodeSqliteDatabase(file);
  db.exec(sql);
  await assert.rejects(inspectDatabasePort({ engine: "sqlite", db }, descriptor), error);
}

const legacyPath = path.join(directory, "legacy.sqlite");
{
  using db = openNodeSqliteDatabase(legacyPath);
  db.exec(
    descriptor.sqlite
      .replace(", edits INTEGER NOT NULL", "")
      .replace(descriptor.triggers![0]!.sql, ""),
  );
  db.exec("PRAGMA user_version = 1; INSERT INTO port_items VALUES ('legacy', 'original')");
  db.exec(descriptor.triggers![0]!.sql);
}
const legacyHash = await hash(legacyPath);
const privatePath = path.join(directory, "private.sqlite");
await fs.copyFile(legacyPath, privatePath);
const legacy = await runDatabasePortTask(
  { operation: "inspect", sourcePath: legacyPath, config, to: "postgres" },
  scope,
);
assert.equal(legacy.migrationRequired, true);
const migrated = await runDatabasePortTask(
  { operation: "migrate", sourcePath: privatePath },
  scope,
);
assert.deepEqual(Object.keys(migrated.verification.tables), ["port_items"]);
assert.equal(await hash(legacyPath), legacyHash);
{
  using db = openNodeSqliteDatabase(privatePath);
  assert.equal(db.prepare("SELECT edits FROM port_items").get()?.edits, 0);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
}

const client = new Client({ connectionString: connection });
await client.connect();
try {
  const staged = await runDatabasePortTask(
    {
      operation: "stage",
      sourcePath,
      targetPath: anchorPath,
      config,
      to: "postgres",
      storeId,
      namespace,
    },
    scope,
  );
  assert.equal(staged.verification.tables.port_items?.rows, 1);
  assert.equal(staged.verification.tables.port_notes?.rows, 1);
  assert.equal(staged.verification.tables.port_projection, undefined);
  assert.deepEqual((await client.query(`SELECT * FROM "${namespace}".port_projection`)).rows, [
    { id: "first", value: "RETAINED" },
  ]);
  assert.equal(await hash(sourcePath), original);
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
        fingerprintPostgresBackup(anchorPath, config),
        /Unknown PostgreSQL trigger or view/,
      );
    } finally {
      await client.query(drop);
    }
  }
  const fingerprint = await fingerprintPostgresBackup(anchorPath, config);
  const backupDirectory = path.join(directory, "backup");
  const manifest = await capturePostgresBackup({
    sourcePath: anchorPath,
    directory: backupDirectory,
    config,
    profile: "exact",
    ...scope,
  });
  assert.equal(manifest.source.owner, "synthetic");
  assert.deepEqual(manifest.activeFragments, ["labels", "notes"]);
  assert.deepEqual(manifest.verification, staged.verification);
  assert.equal(await fingerprintPostgresBackup(anchorPath, config), fingerprint);
  const imageProbe = path.join(directory, "image-probe.sqlite");
  await fs.copyFile(path.join(backupDirectory, "database.sqlite"), imageProbe);
  expectImage(imageProbe);
  const manifestPath = path.join(backupDirectory, SNAPSHOT_MANIFEST_FILENAME);
  const originalManifest = await fs.readFile(manifestPath);
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, activeFragments: ["labels"] }));
  try {
    await assert.rejects(
      preparePostgresRestore({
        directory: backupDirectory,
        anchorPath: path.join(directory, "refused.sqlite"),
        config,
        profile: "exact",
        ...scope,
      }),
      /Port source fragments differ from the recorded backup/,
    );
  } finally {
    await fs.writeFile(manifestPath, originalManifest);
  }
  const restoredPath = path.join(directory, "restored-anchor.sqlite");
  const restored = await preparePostgresRestore({
    directory: backupDirectory,
    anchorPath: restoredPath,
    config,
    profile: "exact",
    ...scope,
  });
  namespaces.add(restored.namespace);
  assert.deepEqual((await client.query(`SELECT * FROM "${restored.namespace}".port_notes`)).rows, [
    { id: "note", value: "note value" },
  ]);
  assert.deepEqual(
    (await client.query(`SELECT * FROM "${restored.namespace}".port_projection`)).rows,
    [{ id: "first", value: "RETAINED" }],
  );
  const restoredAnchor = readBackupEngine(restoredPath);
  assert.equal(restoredAnchor.engine, "postgres");
  assert(restoredAnchor.engine === "postgres");
  const reversePath = path.join(directory, "reverse.sqlite");
  await withDatabasePortPostgres(config, restoredAnchor, async (db, family) => {
    using target = openNodeSqliteDatabase(reversePath, { readBigInts: true });
    const reversed = await materializeDatabasePort({
      source: { engine: "postgres", db, namespace: restored.namespace },
      destination: { engine: "sqlite", db: target },
      descriptor: family,
      storeId,
      ...scope,
    });
    assert.deepEqual(reversed, staged.verification);
  });
  expectImage(reversePath);
  const restoredFingerprint = await fingerprintPostgresBackup(restoredPath, config);
  await client.query(`INSERT INTO "${restored.namespace}".port_items VALUES ('probe', 'probe', 0)`);
  assert.deepEqual(
    (await client.query(`SELECT edits FROM "${restored.namespace}".port_items WHERE id = 'probe'`))
      .rows,
    [{ edits: "1" }],
  );
  assert.notEqual(await fingerprintPostgresBackup(restoredPath, config), restoredFingerprint);
  console.log("synthetic family verified");
} finally {
  for (const owned of namespaces) {
    await client.query(`DROP SCHEMA IF EXISTS "${owned}" CASCADE`);
  }
  await client.end();
}
