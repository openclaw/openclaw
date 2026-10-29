import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { decodePostgresError } from "../infra/postgres-sync/protocol.js";
import { isMissingPluginStateTableError } from "./plugin-state-store.database.js";

describe("missing plugin state table", () => {
  it("recognizes SQLite's missing table error", () => {
    const db = new DatabaseSync(":memory:");
    try {
      let failure: unknown;
      try {
        db.prepare("SELECT * FROM plugin_state_entries").all();
      } catch (error) {
        failure = error;
      }
      expect(isMissingPluginStateTableError(failure)).toBe(true);
    } finally {
      db.close();
    }
  });

  it.each([
    ['relation "plugin_state_entries" does not exist', "42P01", true],
    ['relation "other_entries" does not exist', "42P01", false],
    ['relation "plugin_state_entries" does not exist', "42501", false],
    ['column "plugin_state_entries" does not exist', "42703", false],
  ])("classifies normalized PostgreSQL error %s (%s)", (message, code, expected) => {
    const error = decodePostgresError({ name: "error", message, code });
    expect(isMissingPluginStateTableError(error)).toBe(expected);
  });
});
