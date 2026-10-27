import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retireDoctorA2uiWidgets } from "./doctor-a2ui-widgets.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";

it("backs up legacy widgets, retires A2UI, and preserves other retired renderers as readable source", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:dashboard:migration";
    const work = { sessionKey: "agent:work:dashboard:migration", agentId: "work" };
    const source = '<script>alert("source")</script>\nDiagram source';
    const registeredManifest = {
      contentOwner: "registered",
      registeredContentKind: "diagram",
      registeredInstanceId: "a".repeat(32),
      netOrigins: ["https://example.com"],
      tools: ["exec"],
      presentation: "full-bleed",
      heightMode: "auto",
      nameIdentity: { kind: "generated", source: "show_widget", key: "b".repeat(64) },
      unrelatedMetadata: "kept verbatim",
    };
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => {},
    });
    try {
      await maintenance.run(async () => {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const databasePath = database.path;
        const directory = path.dirname(databasePath);
        const sql = sessionSqlFixture(database.db);
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
        const previousFiles = new Set(fs.readdirSync(directory));
        for (const [name, pluginKind, manifest, widgetSource] of [
          ["legacy-plugin", "canvas:a2ui", {}],
          [
            "legacy-registered",
            "canvas:retired",
            { contentOwner: "registered", registeredContentKind: "a2ui" },
          ],
          ["current-plugin", "test:chart", { contentOwner: "plugin" }],
          ["converted", "example:diagram", registeredManifest, source],
          ["converted-pre-owner", "example:legacy", {}, source],
        ] as const) {
          sql`INSERT INTO board_widgets
        (session_key, name, tab_id, content_kind, descriptor_json, sha256, revision, size_w, size_h, position, manifest, created_by, created_at, updated_at)
        VALUES (${sessionKey}, ${name}, 'main', 'plugin', ${JSON.stringify({ pluginKind, ...(widgetSource === undefined ? {} : { source: widgetSource, extra: "preserved" }) })}, 'hash', 1, 1, 1, 0, ${JSON.stringify(manifest)}, 'user', 1, 1)`.run();
        }
        sql`UPDATE board_widgets SET grant_state = 'granted', granted_sha = 'hash' WHERE name = 'converted'`.run();
        sql`INSERT INTO board_widgets
      (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, created_by, created_at, updated_at)
      VALUES (${sessionKey}, 'html', 'main', 'html', X'3C703E48656C6C6F3C2F703E', 'hash-html', ${"d".repeat(32)}, 1, 1, 1, 1, 'user', 1, 1)`.run();
        sql`INSERT INTO board_widgets
      (session_key, name, tab_id, content_kind, descriptor_json, sha256, revision, size_w, size_h, position, manifest, created_by, created_at, updated_at)
      VALUES (${sessionKey}, 'mcp-app', 'main', 'mcp-app', '{"serverId":"test","resourceUri":"ui://test"}', 'hash-mcp', 1, 1, 1, 2, ${JSON.stringify({ mcpAppInteractive: false, mcpAppInstanceId: "c".repeat(32) })}, 'user', 1, 1)`.run();
        const original = sql`SELECT * FROM board_widgets ORDER BY name`.all();
        const registeredOnly = openOpenClawAgentDatabase({ agentId: "work", env: state.env });
        const otherSql = sessionSqlFixture(registeredOnly.db);
        otherSql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
          VALUES (${work.sessionKey}, 'session-work', '{"sessionId":"session-work","updatedAt":1}', 1)`.run();
        otherSql`INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision)
          VALUES (${work.sessionKey}, 'main', 'Main', 0, 'user', 0)`.run();
        otherSql`INSERT INTO board_widgets
          (session_key, name, tab_id, content_kind, descriptor_json, sha256, revision, size_w, size_h, position, manifest, created_by, created_at, updated_at)
          VALUES (${work.sessionKey}, 'malformed-source', 'main', 'plugin', 'unparseable <source>', 'hash', 1, 1, 1, 0, ${JSON.stringify({ contentOwner: "registered" })}, 'user', 1, 1)`.run();
        await closeOpenClawAgentDatabasesAsync();

        const result = await retireDoctorA2uiWidgets({ cfg: {}, env: state.env });
        expect(result.warnings).toEqual([
          expect.stringContaining("Deleted 2 stored widget(s) after backup"),
          expect.stringContaining("Converted 3 other retired widget(s) to inert HTML"),
        ]);
        const backupNames = fs
          .readdirSync(directory)
          .filter(
            (name) =>
              name.startsWith(`${path.basename(databasePath)}.pre-startup-migration-`) &&
              name.endsWith(".bak") &&
              !previousFiles.has(name),
          );
        expect(backupNames).toHaveLength(1);
        const backupPath = path.join(directory, backupNames[0]!);
        expect(result.changes.some((change) => change.includes(backupPath))).toBe(true);
        using backup = new DatabaseSync(backupPath, { readOnly: true });
        expect(backup.prepare("SELECT * FROM board_widgets ORDER BY name").all()).toEqual(original);

        using repaired = new DatabaseSync(databasePath, { readOnly: true });
        const query = sessionSqlFixture(repaired);
        expect(
          query`SELECT * FROM board_widgets WHERE name NOT LIKE 'converted%' ORDER BY name`.all(),
        ).toEqual(
          original.filter(
            (row) =>
              !String(row.name).startsWith("legacy-") && !String(row.name).startsWith("converted"),
          ),
        );
        const converted = query`SELECT * FROM board_widgets WHERE name = 'converted'`.get();
        expect(converted).toMatchObject({
          descriptor_json: null,
          granted_sha: null,
          revision: 2,
        });
        expect(JSON.parse(String(converted?.manifest))).toMatchObject({
          contentOwner: "html",
          nameIdentity: registeredManifest.nameIdentity,
        });
        expect(query`SELECT title FROM board_tabs`.get()?.title).toBe("Main");
        expect(await retireDoctorA2uiWidgets({ cfg: {}, env: state.env })).toMatchObject({
          changes: [],
          warnings: [],
        });
      });
    } finally {
      await maintenance.close();
    }
    const store = new SqliteBoardStore({
      env: state.env,
      resolveSession: ({ sessionKey: requestedSessionKey, agentId }) => ({
        sessionKey: requestedSessionKey,
        agentId: agentId ?? "main",
      }),
    });
    const snapshot = await store.getSnapshot({ sessionKey });
    expect(snapshot.widgets).toHaveLength(5);
    expect(snapshot.widgets.find((widget) => widget.name === "converted")).toMatchObject({
      contentKind: "html",
      contentOwner: "html",
      grantState: "none",
      presentation: "full-bleed",
      heightMode: "auto",
    });
    const preview = await store.useWidgetDocument({ sessionKey }, "converted", (document) =>
      document && "html" in document ? document : undefined,
    );
    expect(preview?.declared).toBeUndefined();
    expect(preview?.html).toContain(
      "&lt;script&gt;alert(&quot;source&quot;)&lt;/script&gt;\nDiagram source",
    );
    expect(preview?.html).toContain("&quot;extra&quot;:&quot;preserved&quot;");
    expect(preview?.html).toContain("&quot;unrelatedMetadata&quot;:&quot;kept verbatim&quot;");
    expect(preview?.html).not.toContain("<script>");
    const registeredOnlySnapshot = await store.getSnapshot(work);
    expect(registeredOnlySnapshot.widgets).toHaveLength(1);
    expect(registeredOnlySnapshot.widgets[0]).toMatchObject({
      contentKind: "html",
      contentOwner: "html",
    });
    const malformedPreview = await store.useWidgetDocument(work, "malformed-source", (document) =>
      document && "html" in document ? document.html : undefined,
    );
    expect(malformedPreview).toContain("unparseable &lt;source&gt;");
  });
});
