import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { PostgresSyncConnection } from "./connection.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("PostgreSQL session settings", () => {
  it("inherits commit durability while applying settings with a quoted, comma-containing schema name", async () => {
    const schema = `settings_${randomUUID().replaceAll("-", "")}_"first,second`;
    const quoted = `"${schema.replaceAll('"', '""')}"`;
    const admin = new Client({ connectionString: connection });
    const anchor = new DatabaseSync(":memory:");
    let db: PostgresSyncConnection | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quoted}`);
      const defaults = await admin.query<{ synchronous_commit: string }>(
        "SELECT current_setting('synchronous_commit') AS synchronous_commit",
      );
      withEngineStoreAdmission(() => {
        db = new PostgresSyncConnection(connection!, schema, anchor, schema, {
          lockTimeoutMs: 321,
          statementTimeoutMs: 654,
        });
        expect(
          db.query(
            "SELECT current_setting('synchronous_commit') AS synchronous_commit, " +
              "current_setting('lock_timeout') AS lock_timeout, " +
              "current_setting('statement_timeout') AS statement_timeout, " +
              "current_setting('search_path') AS search_path",
          ).rows,
        ).toEqual([
          {
            synchronous_commit: defaults.rows[0]?.synchronous_commit,
            lock_timeout: "321ms",
            statement_timeout: "654ms",
            search_path: quoted,
          },
        ]);
      });
    } finally {
      try {
        db?.close();
        anchor.close();
        await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });
});
