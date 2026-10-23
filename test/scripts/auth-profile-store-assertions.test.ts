import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  assertNoLegacyPrimaryAuthRows,
  readCanonicalAuthProfileStoreText,
  readSharedAuthProfileStoreText,
} from "../../scripts/e2e/lib/auth-profile-store-assertions.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const PRIMARY_STORE = '{"version":1,"profiles":{}}';

let stateDir: string;
beforeEach(() => {
  stateDir = path.join(tempDirs.make("openclaw-auth-profile-assertions-"), ".openclaw");
});

function writeDatabase(dbPath: string, populate: (db: DatabaseSync) => void) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    populate(db);
  } finally {
    db.close();
  }
}

function writeStore(
  db: DatabaseSync,
  table: string,
  rowKey: string,
  storeJson = "{}",
  asView = false,
) {
  const [key, value, updated] =
    table === "config_machine_state"
      ? ["state_key", "value_json", "updated_at_ms"]
      : ["store_key", "store_json", "updated_at"];
  if (asView) {
    db.exec(
      `CREATE VIEW ${table} AS SELECT '${rowKey}' AS ${key}, '{}' AS ${value}, 1 AS ${updated}`,
    );
  } else {
    db.exec(`CREATE TABLE ${table} (
      ${key} TEXT NOT NULL PRIMARY KEY, ${value} TEXT NOT NULL, ${updated} INTEGER NOT NULL
    ) STRICT`);
    db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(rowKey, storeJson, Date.now());
  }
}

function writeSharedDatabase(
  options: {
    asView?: boolean;
    withoutCanonicalTable?: boolean;
    schemaVersion?: 1 | 7 | 12 | 13;
    storeJson?: string;
  } = {},
): void {
  return writeDatabase(path.join(stateDir, "state", "openclaw.sqlite"), (db) => {
    const schemaVersion = options.schemaVersion ?? 13;
    db.exec(`PRAGMA user_version = ${schemaVersion};`);
    const table = schemaVersion >= 13 ? "config_machine_state" : "auth_profile_stores";
    if (!options.withoutCanonicalTable) {
      writeStore(
        db,
        table,
        schemaVersion >= 13 ? "authProfiles.store" : "shared",
        options.storeJson,
        options.asView,
      );
    }
  });
}

function writeAgentDatabase(asView = false) {
  const file = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
  writeDatabase(file, (db) =>
    writeStore(db, "auth_profile_store", "primary", PRIMARY_STORE, asView),
  );
}

it("reads the release-owned shared row before schema v13", () => {
  writeSharedDatabase({ schemaVersion: 12, storeJson: '{"version":1,"schema":12}' });

  expect(readSharedAuthProfileStoreText(stateDir)).toBe('{"version":1,"schema":12}');
});

it("reads and permits the pre-v13 primary agent-store contract", () => {
  writeAgentDatabase();

  expect(readCanonicalAuthProfileStoreText(stateDir)).toBe('{"version":1,"profiles":{}}');
  expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).not.toThrow();
});

it("uses the agent store before the shared-auth schema boundary", () => {
  // Candidate 2026.6.35 creates this unused state table at schema v1 while
  // its auth runtime still owns primary credentials in the agent database.
  writeSharedDatabase({ schemaVersion: 1, storeJson: '{"shared":true}' });
  writeAgentDatabase();

  expect(readSharedAuthProfileStoreText(stateDir)).toBe("");
  expect(readCanonicalAuthProfileStoreText(stateDir)).toBe('{"version":1,"profiles":{}}');
  expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).not.toThrow();
});

it("does not let a retired agent row mask a missing v7 shared table", () => {
  writeSharedDatabase({ schemaVersion: 7, withoutCanonicalTable: true });
  writeAgentDatabase();

  expect(readCanonicalAuthProfileStoreText(stateDir)).toBe("");
  expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).toThrow(
    "onboard preserved a retired primary row in auth_profile_store",
  );
});

it("fails closed when the shared auth table is replaced by a view", () => {
  writeSharedDatabase({ asView: true });

  expect(() => readSharedAuthProfileStoreText(stateDir)).toThrow(
    "config_machine_state is view, not a table",
  );
});

it("fails closed when a retired auth table is replaced by a view", () => {
  writeSharedDatabase();
  writeAgentDatabase(true);

  expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).toThrow(
    "auth_profile_store is view, not a table",
  );
});
