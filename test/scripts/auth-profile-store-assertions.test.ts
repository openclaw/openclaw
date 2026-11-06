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
const primary = '{"version":1,"profiles":{}}';
let stateDir: string;
beforeEach(() => {
  stateDir = tempDirs.make("auth-profile-assertions-");
});

function database(file: string, sql: string) {
  const target = path.join(stateDir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
const shared = (version: number, sql = "") =>
  database("state/openclaw.sqlite", `PRAGMA user_version = ${version}; ${sql}`);
const agent = (view = false) =>
  database(
    "agents/main/agent/openclaw-agent.sqlite",
    view
      ? "CREATE VIEW auth_profile_store AS SELECT 1;"
      : `CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
     INSERT INTO auth_profile_store VALUES ('primary', '${primary}');`,
  );

it("reads the release-owned shared row before schema v13", () => {
  shared(
    12,
    `CREATE TABLE auth_profile_stores (store_key TEXT PRIMARY KEY, store_json TEXT);
    INSERT INTO auth_profile_stores VALUES ('shared', '{"version":1,"schema":12}');`,
  );
  expect(readSharedAuthProfileStoreText(stateDir)).toBe('{"version":1,"schema":12}');
});

it("uses the agent store before shared-auth ownership", () => {
  shared(1);
  agent();
  expect(readSharedAuthProfileStoreText(stateDir)).toBe("");
  expect(readCanonicalAuthProfileStoreText(stateDir)).toBe(primary);
  expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).not.toThrow();
});

it("does not let a retired agent row mask a missing v7 shared table", () => {
  shared(7);
  agent();
  expect(readCanonicalAuthProfileStoreText(stateDir)).toBe("");
  expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).toThrow(
    "onboard preserved a retired primary row in auth_profile_store",
  );
});

it("fails closed when the shared auth table is replaced by a view", () => {
  shared(13, "CREATE VIEW config_machine_state AS SELECT 1;");
  expect(() => readSharedAuthProfileStoreText(stateDir)).toThrow(
    "config_machine_state is view, not a table",
  );
});

it("fails closed when a retired auth table is replaced by a view", () => {
  shared(13);
  agent(true);
  expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).toThrow(
    "auth_profile_store is view, not a table",
  );
});
