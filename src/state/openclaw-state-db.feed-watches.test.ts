import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenClaw state feed watch migration", () => {
  it("adds v5 watch tables after the v4 cursor migration without losing snapshots", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-feed-watch-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "state.sqlite");
    const opened = openOpenClawStateDatabase({ path: databasePath });
    opened.db
      .prepare(
        `INSERT INTO official_external_plugin_catalog_snapshots (
          feed_url, body, status, etag, last_modified, checksum, saved_at,
          trust_mode, trust_key_id, trust_signature_count, trust_threshold,
          trust_verified_at, updated_at_ms
        ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "https://clawhub.ai/v1/feeds/plugins",
        '{"sequence":7}',
        200,
        "sha256:accepted",
        "2026-07-17T00:00:00.000Z",
        "signed",
        "clawhub-feed-2026",
        1,
        1,
        "2026-07-17T00:00:00.000Z",
        1,
      );
    closeOpenClawStateDatabaseForTest();

    const sqlite = requireNodeSqlite();
    const legacy = new sqlite.DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE marketplace_feed_updates;
      DROP TABLE marketplace_feed_watches;
      PRAGMA user_version = 3;
      UPDATE schema_meta SET schema_version = 3 WHERE meta_key = 'primary';
    `);
    legacy.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations({ path: databasePath })).toEqual([
      { kind: "session-watch-cursor-provenance-v4", path: databasePath },
      { kind: "marketplace-feed-watches-v6", path: databasePath },
    ]);

    const migrated = openOpenClawStateDatabase({ path: databasePath });
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare(
          "SELECT checksum FROM official_external_plugin_catalog_snapshots WHERE feed_url = ?",
        )
        .get("https://clawhub.ai/v1/feeds/plugins"),
    ).toEqual({ checksum: "sha256:accepted" });
    expect(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?) ORDER BY name",
        )
        .all("marketplace_feed_updates", "marketplace_feed_watches"),
    ).toEqual([{ name: "marketplace_feed_updates" }, { name: "marketplace_feed_watches" }]);
  });
});
