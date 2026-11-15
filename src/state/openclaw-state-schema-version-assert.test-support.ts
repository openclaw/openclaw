import { expect } from "vitest";
import type { EngineConnection } from "../infra/sql-connection.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

export function expectSchemaVersion(db: EngineConnection, version = OPENCLAW_STATE_SCHEMA_VERSION) {
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({
    schema_version: version,
  });
}
