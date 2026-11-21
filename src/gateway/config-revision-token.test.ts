import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase as openDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest as closeDatabase } from "../test-utils/database-cleanup.js";
import { loadGatewayConfigRevisionProjector as loadProjector } from "./config-revision-token.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeDatabase();
    cleanup();
  });
});

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-config-revision-"), "openclaw.sqlite") };
}

it("lazily persists one opaque domain-separated key without changing schema version", async () => {
  const options = stateOptions();
  const database = openDatabase(options).db;
  const schemaVersion = database.prepare("PRAGMA user_version").get()?.user_version;
  database.exec("DROP TABLE config_revision_keys;");
  await closeDatabase();
  const reopened = openDatabase(options).db;
  expect(tableExists(reopened, "config_revision_keys")).toBe(false);

  await closeDatabase();
  const projector = await loadProjector(options);
  await closeDatabase();
  const stored = openDatabase(options).db;
  const rawHash = "raw-config-hash";
  const rawToken = projector.projectRawHash(rawHash);
  const { hmac_key: key } = stored
    .prepare("SELECT hmac_key FROM config_revision_keys WHERE id = 1")
    .get() as { hmac_key: Uint8Array };
  const bearer = "synthetic-operator-password";
  const subject = projector.hashResponseSessionBearer(bearer);
  expect(subject).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/u);
  expect(subject.includes(createHmac("sha256", key).update(bearer).digest("hex"))).toBe(false);
  expect((await loadProjector(stateOptions())).hashResponseSessionBearer(bearer)).not.toBe(subject);

  expect(stored.prepare("PRAGMA user_version").get()?.user_version).toBe(schemaVersion);
  expect(key).toHaveLength(32);
  expect(rawToken).toMatch(/^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u);
  expect(rawToken).not.toContain(rawHash);
  expect(rawToken).not.toContain(Buffer.from(key).toString("base64url"));
  expect(projector.projectResolvedHash(rawHash)).not.toBe(rawToken);
  expect(projector.projectRawHash(rawHash)).toBe(rawToken);
  expect(projector.projectRawHash(`${rawHash}0`)).not.toBe(rawToken);

  await closeDatabase();
  const reloaded = await loadProjector(options);
  expect(reloaded.projectRawHash(rawHash)).toBe(rawToken);
  expect(reloaded.hashResponseSessionBearer(bearer)).toBe(subject);
});

it("fails closed instead of replacing corrupt persisted key material", async () => {
  const options = stateOptions();
  await loadProjector(options);
  await closeDatabase();
  const database = openDatabase(options).db;
  database.exec("PRAGMA ignore_check_constraints = ON;");
  database
    .prepare("UPDATE config_revision_keys SET hmac_key = ? WHERE id = 1")
    .run(randomBytes(31));
  database.exec("PRAGMA ignore_check_constraints = OFF;");

  await closeDatabase();
  await expect(loadProjector(options)).rejects.toThrow();
  await closeDatabase();
  // Inspect preserved corrupt bytes without readmitting the database.
  const { DatabaseSync } = requireNodeSqlite();
  using inspection = new DatabaseSync(options.path, { readOnly: true });
  expect(
    inspection
      .prepare("SELECT length(hmac_key) AS size FROM config_revision_keys WHERE id = 1")
      .get(),
  ).toEqual({ size: 31 });
});
