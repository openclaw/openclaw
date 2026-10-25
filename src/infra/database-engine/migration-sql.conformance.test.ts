import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_AUDIT_SCOPE } from "../../config/io.audit.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { SYSTEM_AGENT_AUDIT_SCOPE } from "../../system-agent/audit.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { createLegacyAuditDatabaseWitness } from "../state-migrations.audit-backup.js";
import { migrateLegacyDebugProxyCaptureSidecar } from "../state-migrations.debug-proxy.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function writeLegacyCapture(sourcePath: string): void {
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const source = openNodeSqliteDatabase(sourcePath);
  try {
    source.exec(`
      CREATE TABLE capture_sessions (
        id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER, mode TEXT,
        source_scope TEXT, source_process TEXT, proxy_url TEXT, db_path TEXT, blob_dir TEXT
      );
      CREATE TABLE capture_events (
        id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, source_scope TEXT,
        source_process TEXT, protocol TEXT, direction TEXT, kind TEXT, flow_id TEXT,
        method TEXT, host TEXT, path TEXT, status INTEGER, close_code INTEGER,
        content_type TEXT, headers_json TEXT, data_text TEXT, data_blob_id TEXT,
        data_sha256 TEXT, error_text TEXT, meta_json TEXT
      );
    `);
    source
      .prepare(
        "INSERT INTO capture_sessions VALUES ('migration-session', 100, NULL, 'record', 'synthetic', 'test', NULL, ?, ?)",
      )
      .run(sourcePath, path.join(path.dirname(sourcePath), "blobs"));
    const insert = source.prepare(
      `INSERT INTO capture_events (
        session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
        method, status, close_code, data_text
      ) VALUES ('migration-session', 100, 'synthetic', 'test', 'http', 'request', 'request', 'flow', ?, ?, ?, ?)`,
    );
    insert.run(null, null, null, null);
    insert.run(null, null, null, null);
    insert.run("GET", 200, 1000, "");
  } finally {
    source.close();
  }
}

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} migration SQL portability`,
    () => {
      const pair = useMixedAgentPair(engine, engine);

      it("witnesses only case-sensitive literal legacy prefixes and all raw checkpoints", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase();
          const rows = [
            [CONFIG_AUDIT_SCOPE, "legacy:"],
            [CONFIG_AUDIT_SCOPE, "legacy:%_literal"],
            [CONFIG_AUDIT_SCOPE, "legacy:tail"],
            [CONFIG_AUDIT_SCOPE, "Legacy:upper"],
            [CONFIG_AUDIT_SCOPE, "prelegacy:tail"],
            [CONFIG_AUDIT_SCOPE, "legacyX:tail"],
            [SYSTEM_AGENT_AUDIT_SCOPE, "legacy:system"],
            ["unrelated", "legacy:other"],
            ["migration.legacy-audit-raw", "checkpoint"],
          ] as const;
          runOpenClawStateWriteTransaction(
            () => {
              const insert = database.db.prepare(
                "INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at, sequence) VALUES (?, ?, '{}', 10, 0)",
              );
              for (const [scope, eventKey] of rows) {
                insert.run(scope, eventKey);
              }
            },
            { database },
          );
          const expected = [rows[0], rows[1], rows[2], rows[8], rows[6]].map((row) => ({
            scope: row[0],
            event_key: row[1],
            payload_json: "{}",
            created_at: 10,
            sequence: 0,
          }));
          expect(createLegacyAuditDatabaseWitness(database.db)).toBe(
            createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
          );
        }));

      it("reimports capture sidecars without duplicating equal NULL-bearing or distinct events", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase();
          const sourcePath = path.join(pair.root, "debug-proxy", "capture.sqlite");
          writeLegacyCapture(sourcePath);
          const expected = [
            { method: null, status: null, close_code: null, data_text: null },
            { method: null, status: null, close_code: null, data_text: null },
            { method: "GET", status: 200, close_code: 1000, data_text: "" },
          ];
          for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) {
              fs.copyFileSync(`${sourcePath}.migrated`, sourcePath);
            }
            const migrated = migrateLegacyDebugProxyCaptureSidecar({ stateDir: pair.root });
            expect(migrated.warnings).toEqual([]);
            expect(migrated.changes).not.toEqual([]);
            expect(
              database.db
                .prepare(
                  "SELECT method, status, close_code, data_text FROM capture_events WHERE session_id = 'migration-session' ORDER BY id",
                )
                .all(),
            ).toEqual(expected);
            expect(fs.existsSync(sourcePath)).toBe(false);
          }
        }));
    },
  );
}
