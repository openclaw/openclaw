import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retireDoctorA2uiWidgets } from "./doctor-a2ui-widgets.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";

it("backs up and retires both stored A2UI shapes while preserving other widgets", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => {},
    });
    try {
      await maintenance.run(async () => {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const databasePath = database.path;
        const sql = sessionSqlFixture(database.db);
        const sessionKey = "agent:main:dashboard:migration";
        sql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES (${sessionKey}, 'session-migration', '{"sessionId":"session-migration","updatedAt":1}', 1)`.run();
        sql`INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision)
      VALUES (${sessionKey}, 'main', 'Main', 0, 'user', 0)`.run();
        // A prior Doctor run must not cause retirement to reuse an image without these widgets.
        await backupDoctorMigrationDatabases({
          env: state.env,
          pendingDatabasePaths: [databasePath],
          databasePaths: [databasePath],
        });
        const previousFiles = new Set(fs.readdirSync(path.dirname(databasePath)));
        for (const [name, pluginKind, manifest] of [
          ["legacy-plugin", "canvas:a2ui", {}],
          [
            "legacy-registered",
            "canvas:retired",
            { contentOwner: "registered", registeredContentKind: "a2ui" },
          ],
          ["current-plugin", "test:chart", { contentOwner: "plugin" }],
        ] as const) {
          sql`INSERT INTO board_widgets
        (session_key, name, tab_id, content_kind, descriptor_json, sha256, revision, size_w, size_h, position, manifest, created_by, created_at, updated_at)
        VALUES (${sessionKey}, ${name}, 'main', 'plugin', ${JSON.stringify({ pluginKind })}, 'hash', 1, 1, 1, 0, ${JSON.stringify(manifest)}, 'user', 1, 1)`.run();
        }
        sql`INSERT INTO board_widgets
      (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, created_by, created_at, updated_at)
      VALUES (${sessionKey}, 'html', 'main', 'html', X'3C703E48656C6C6F3C2F703E', 'hash-html', 'view', 1, 1, 1, 1, 'user', 1, 1)`.run();
        sql`INSERT INTO board_widgets
      (session_key, name, tab_id, content_kind, descriptor_json, sha256, revision, size_w, size_h, position, created_by, created_at, updated_at)
      VALUES (${sessionKey}, 'mcp-app', 'main', 'mcp-app', '{"serverId":"test","resourceUri":"ui://test"}', 'hash-mcp', 1, 1, 1, 2, 'user', 1, 1)`.run();
        const original = sql`SELECT * FROM board_widgets ORDER BY name`.all();
        await closeOpenClawAgentDatabasesAsync();

        const result = await retireDoctorA2uiWidgets({ cfg: {}, env: state.env });
        expect(result.warnings).toEqual([
          "Deleted 2 stored widget(s) after backup. A2UI widgets were retired and can be recreated as HTML widgets.",
        ]);
        const backupNames = fs
          .readdirSync(path.dirname(databasePath))
          .filter(
            (name) =>
              name.startsWith(`${path.basename(databasePath)}.pre-startup-migration-`) &&
              name.endsWith(".bak") &&
              !previousFiles.has(name),
          );
        expect(backupNames).toHaveLength(1);
        const backupPath = path.join(path.dirname(databasePath), backupNames[0]!);
        expect(result.changes.some((change) => change.includes(backupPath))).toBe(true);
        using backup = new DatabaseSync(backupPath, { readOnly: true });
        expect(backup.prepare("SELECT * FROM board_widgets ORDER BY name").all()).toEqual(original);

        using repaired = new DatabaseSync(databasePath, { readOnly: true });
        expect(repaired.prepare("SELECT * FROM board_widgets ORDER BY name").all()).toEqual(
          original.filter((row) => !String(row.name).startsWith("legacy-")),
        );
        expect(repaired.prepare("SELECT title FROM board_tabs").get()?.title).toBe("Main");
        expect(await retireDoctorA2uiWidgets({ cfg: {}, env: state.env })).toMatchObject({
          changes: [],
          warnings: [],
        });
      });
    } finally {
      await maintenance.close();
    }
  });
});
