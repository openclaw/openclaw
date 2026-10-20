import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoLegacyPrimaryAuthRows,
  readCanonicalAuthProfileStoreText,
  readSharedAuthProfileStoreText,
} from "../../scripts/e2e/lib/auth-profile-store-assertions.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeStateDir(): string {
  const root = tempDirs.make("openclaw-auth-profile-assertions-");
  return path.join(root, ".openclaw");
}

function writeSharedDatabase(
  stateDir: string,
  options: {
    asView?: boolean;
    withoutCanonicalTable?: boolean;
    schemaVersion?: 1 | 7 | 12 | 13;
    storeJson?: string;
  } = {},
): string {
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    const schemaVersion = options.schemaVersion ?? 13;
    db.exec(`PRAGMA user_version = ${schemaVersion};`);
    const table = schemaVersion >= 13 ? "config_machine_state" : "auth_profile_stores";
    if (options.withoutCanonicalTable) {
      // The schema version is authoritative for the owner. Leave this database
      // intentionally missing its expected table to exercise that boundary.
    } else if (options.asView) {
      if (table === "config_machine_state") {
        db.exec(`
          CREATE VIEW config_machine_state AS
            SELECT 'authProfiles.store' AS state_key, '{}' AS value_json, 1 AS updated_at_ms;
        `);
      } else {
        db.exec(`
          CREATE VIEW auth_profile_stores AS
            SELECT 'shared' AS store_key, '{}' AS store_json, 1 AS updated_at;
        `);
      }
    } else if (table === "config_machine_state") {
      db.exec(`
          CREATE TABLE config_machine_state (
            state_key TEXT NOT NULL PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
          ) STRICT;
        `);
      db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
        "authProfiles.store",
        options.storeJson ?? "{}",
        Date.now(),
      );
    } else {
      db.exec(`
        CREATE TABLE auth_profile_stores (
          store_key TEXT NOT NULL PRIMARY KEY,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      db.prepare("INSERT INTO auth_profile_stores VALUES (?, ?, ?)").run(
        "shared",
        options.storeJson ?? "{}",
        Date.now(),
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function writeAgentDatabase(
  stateDir: string,
  options: {
    storeJson?: string;
    storeKeys?: string[];
    storeAsView?: boolean;
  } = {},
): string {
  const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    if (options.storeAsView) {
      db.exec(`
        CREATE VIEW auth_profile_store AS
          SELECT 'primary' AS store_key, '{}' AS store_json, 1 AS updated_at;
      `);
    } else {
      db.exec(`
        CREATE TABLE auth_profile_store (
          store_key TEXT NOT NULL PRIMARY KEY,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      for (const key of options.storeKeys ?? []) {
        db.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run(
          key,
          options.storeJson ?? "{}",
          Date.now(),
        );
      }
    }
  } finally {
    db.close();
  }
  return dbPath;
}

describe("auth profile store E2E assertions", () => {
  it("reads the release-owned shared row before schema v13", () => {
    const stateDir = makeStateDir();
    writeSharedDatabase(stateDir, {
      schemaVersion: 12,
      storeJson: '{"version":1,"schema":12}',
    });

    expect(readSharedAuthProfileStoreText(stateDir)).toBe('{"version":1,"schema":12}');
  });

  it("reads and permits the pre-v13 primary agent-store contract", () => {
    const stateDir = makeStateDir();
    writeAgentDatabase(stateDir, {
      storeJson: '{"version":1,"profiles":{}}',
      storeKeys: ["primary"],
    });

    expect(readCanonicalAuthProfileStoreText(stateDir)).toBe('{"version":1,"profiles":{}}');
    expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).not.toThrow();
  });

  it("uses the agent store before the shared-auth schema boundary", () => {
    const stateDir = makeStateDir();
    // Candidate 2026.6.35 creates this unused state table at schema v1 while
    // its auth runtime still owns primary credentials in the agent database.
    writeSharedDatabase(stateDir, { schemaVersion: 1, storeJson: '{"shared":true}' });
    writeAgentDatabase(stateDir, {
      storeJson: '{"version":1,"profiles":{}}',
      storeKeys: ["primary"],
    });

    expect(readSharedAuthProfileStoreText(stateDir)).toBe("");
    expect(readCanonicalAuthProfileStoreText(stateDir)).toBe('{"version":1,"profiles":{}}');
    expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).not.toThrow();
  });

  it("does not let a retired agent row mask a missing v7 shared table", () => {
    const stateDir = makeStateDir();
    writeSharedDatabase(stateDir, {
      schemaVersion: 7,
      withoutCanonicalTable: true,
    });
    writeAgentDatabase(stateDir, {
      storeJson: '{"version":1,"profiles":{}}',
      storeKeys: ["primary"],
    });

    expect(readCanonicalAuthProfileStoreText(stateDir)).toBe("");
    expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).toThrow(
      "onboard preserved a retired primary row in auth_profile_store",
    );
  });

  it("fails closed when the shared auth table is replaced by a view", () => {
    const stateDir = makeStateDir();
    writeSharedDatabase(stateDir, { asView: true });

    expect(() => readSharedAuthProfileStoreText(stateDir)).toThrow(
      "config_machine_state is view, not a table",
    );
  });

  it("fails closed when a retired auth table is replaced by a view", () => {
    const stateDir = makeStateDir();
    writeSharedDatabase(stateDir);
    writeAgentDatabase(stateDir, { storeAsView: true });

    expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).toThrow(
      "auth_profile_store is view, not a table",
    );
  });
});
