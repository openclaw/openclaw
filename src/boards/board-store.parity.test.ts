import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readBoardHtml, createTestBoardStore } from "./board-store.test-support.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function seedSession(env: NodeJS.ProcessEnv, agentId: string, sessionKey: string): string {
  const database = openOpenClawAgentDatabase({ agentId, env });
  const sessionId = `session-${agentId}-${sessionKey.replaceAll(":", "-")}`;
  replaceSessionEntrySync(
    { agentId, sessionKey, storePath: database.path },
    { sessionId, updatedAt: Date.now() },
  );
  return database.path;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("SqliteBoardStore behavior", () => {
  const createStore = createTestBoardStore;
  const boardSession = { sessionKey: "agent:main:board" };
  it("persists revisions, layout, bytes, and declared summaries", async () => {
    const store = createStore();
    const first = await store.putWidget({
      ...boardSession,
      name: "weather",
      content: { kind: "html", html: "<p>one</p>" },
      presentation: "frameless",
      heightMode: "auto",
      declared: {
        netOrigins: ["https://weather.example"],
        tools: ["weather.refresh"],
      },
    });
    expect(first).toMatchObject({
      revision: 1,
      tabs: [{ tabId: "main", position: 0 }],
      widgets: [
        {
          name: "weather",
          revision: 1,
          grantState: "pending",
          presentation: "frameless",
          heightMode: "auto",
          declaredSummary: [
            "Network access: https://weather.example",
            "Tool access: weather.refresh",
          ],
          declared: {
            netOrigins: ["https://weather.example"],
            tools: ["weather.refresh"],
          },
        },
      ],
    });
    expect(await readBoardHtml(store, boardSession, "weather")).toMatchObject({
      html: "<p>one</p>",
      revision: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const preparedView = await store.getSnapshotWithHtmlViewMetadata(boardSession);
    expect(preparedView).toMatchObject({
      snapshot: { revision: 1 },
      htmlViewMetadata: new Map([
        [
          "weather",
          expect.objectContaining({
            revision: 1,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        ],
      ]),
    });
    expect(preparedView.htmlViewMetadata.get("weather")).not.toHaveProperty("html");

    // Legacy clients omit heightMode on resize; explicit user sizing must pin.
    const resized = await store.applyOps(boardSession, [
      { kind: "widget_resize", name: "weather", sizeW: 8, sizeH: 6 },
    ]);
    expect(resized).toMatchObject({
      revision: 2,
      widgets: [
        {
          sizeW: 8,
          sizeH: 6,
          revision: 1,
          presentation: "frameless",
          heightMode: "fixed",
        },
      ],
    });
    expect(
      await store.grant(boardSession, "weather", "granted", 1, first.widgets[0]?.instanceId),
    ).toMatchObject({
      revision: 3,
      widgets: [{ grantState: "granted" }],
    });

    const updated = await store.putWidget({
      ...boardSession,
      name: "weather",
      content: { kind: "html", html: "<p>two</p>" },
    });
    expect(updated).toMatchObject({
      revision: 4,
      widgets: [
        {
          revision: 2,
          grantState: "none",
          sizeW: 8,
          sizeH: 6,
          presentation: "frameless",
          heightMode: "fixed",
        },
      ],
    });
    expect(updated.widgets[0]).not.toHaveProperty("declaredSummary");
    expect((await store.getSnapshot(boardSession)).widgets[0]).not.toHaveProperty(
      "declaredSummary",
    );
    expect(updated.widgets[0]).not.toHaveProperty("declared");
  });

  it("keeps content-kind semantics and normalized ordering", async () => {
    const store = createStore();
    await store.applyOps(boardSession, [
      { kind: "tab_create", tabId: "main", title: "Main" },
      { kind: "tab_create", tabId: "notes", title: "Notes" },
    ]);
    await store.putWidget({
      ...boardSession,
      name: "first",
      content: { kind: "html", html: "first" },
    });
    await store.putWidget({
      ...boardSession,
      name: "app",
      content: {
        kind: "mcp-app",
        descriptor: {
          serverName: "server",
          toolName: "tool",
          uiResourceUri: "ui://resource",
          toolCallId: "call",
        },
        interactive: true,
      },
      placement: { tabId: "notes" },
    });
    expect((await store.getSnapshot(boardSession)).widgets).toEqual([
      expect.objectContaining({ name: "first", tabId: "main", position: 0 }),
      expect.objectContaining({ name: "app", tabId: "notes", position: 0 }),
    ]);
    expect(await readBoardHtml(store, boardSession, "app")).toBeUndefined();
    expect(await store.readWidgetMcpApp(boardSession, "app")).toMatchObject({
      descriptor: {
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
      },
      revision: 1,
      instanceId: expect.stringMatching(/^[a-f0-9]{32}$/u),
      interactive: true,
    });
    expect((await store.getSnapshot(boardSession)).widgets[1]?.instanceId).toMatch(
      /^[a-f0-9]{32}$/u,
    );
  });

  it("replaces omitted plugin props without changing unrelated layout state", async () => {
    const store = createStore();
    const initial = await store.putWidget({
      ...boardSession,
      name: "work-item",
      content: {
        kind: "plugin",
        pluginKind: "workboard:card",
        props: { cardId: "card-123", compact: true },
      },
    });
    await store.putWidget({
      ...boardSession,
      name: "left",
      content: { kind: "plugin", pluginKind: "workboard:card", props: { side: "left" } },
    });
    await store.putWidget({
      ...boardSession,
      name: "right",
      content: { kind: "plugin", pluginKind: "workboard:card", props: { side: "right" } },
    });

    expect(initial.widgets[0]).toMatchObject({
      name: "work-item",
      contentKind: "plugin",
      pluginKind: "workboard:card",
      props: { cardId: "card-123", compact: true },
      grantState: "none",
    });
    expect(initial.widgets[0]).not.toHaveProperty("instanceId");
    expect(await readBoardHtml(store, boardSession, "work-item")).toBeUndefined();
    expect(await store.readWidgetMcpApp(boardSession, "work-item")).toBeUndefined();

    const moved = await store.applyOps(boardSession, [
      { kind: "widget_move", name: "work-item", after: "right" },
    ]);
    expect(moved.widgets.map((widget) => widget.name)).toEqual(["left", "right", "work-item"]);
    expect(moved.widgets[2]?.props).toEqual({ cardId: "card-123", compact: true });
    const [left, right] = moved.widgets;

    const put = await store.putWidget({
      ...boardSession,
      name: "work-item",
      content: { kind: "plugin", pluginKind: "workboard:card" },
    });

    expect(put.widgets.map((widget) => widget.name)).toEqual(["left", "right", "work-item"]);
    expect(put.widgets[0]).toEqual(left);
    expect(put.widgets[1]).toEqual(right);
    expect(put.widgets[2]).not.toHaveProperty("props");
    const { resolvedWidgetName: putName, ...putSnapshot } = put;
    expect(putName).toBe("work-item");
    expect(await store.getSnapshot(boardSession)).toEqual(putSnapshot);

    const placed = await store.putWidget({
      ...boardSession,
      name: "work-item",
      content: { kind: "plugin", pluginKind: "workboard:card" },
      placement: { after: "left" },
    });
    expect(placed.widgets.map((widget) => widget.name)).toEqual(["left", "work-item", "right"]);
    expect(placed.widgets[0]).toEqual(left);
    expect(placed.widgets[1]).not.toHaveProperty("props");
    expect(placed.widgets[2]).toEqual({ ...right, position: 2 });
    const { resolvedWidgetName: placedName, ...placedSnapshot } = placed;
    expect(placedName).toBe("work-item");
    expect(await store.getSnapshot(boardSession)).toEqual(placedSnapshot);
  });

  it("rejects oversized plugin props and capability declarations", async () => {
    const store = createStore();
    await expect(
      store.putWidget({
        ...boardSession,
        name: "too-large",
        content: {
          kind: "plugin",
          pluginKind: "workboard:mini",
          props: { value: "x".repeat(8 * 1024) },
        },
      }),
    ).rejects.toThrow("props exceed 8192 UTF-8 bytes");
    await expect(
      store.putWidget({
        ...boardSession,
        name: "declared",
        content: { kind: "plugin", pluginKind: "workboard:card" },
        declared: { tools: ["workboard.cards.move"] },
      }),
    ).rejects.toThrow("do not accept sandbox capability declarations");
  });

  it("preserves grants only for unchanged bytes with equal or narrower declarations", async () => {
    const store = createStore();
    const first = await store.putWidget({
      ...boardSession,
      name: "scoped",
      content: { kind: "html", html: "one" },
      declared: {
        netOrigins: ["https://one.example", "https://two.example"],
        tools: ["weather.read", "weather.refresh"],
      },
    });
    await store.grant(boardSession, "scoped", "granted", 1, first.widgets[0]?.instanceId);

    const equal = await store.putWidget({
      ...boardSession,
      name: "scoped",
      content: { kind: "html", html: "one" },
      declared: {
        netOrigins: ["https://one.example", "https://two.example"],
        tools: ["weather.read", "weather.refresh"],
      },
    });
    expect(equal.widgets[0]).toMatchObject({ revision: 2, grantState: "granted" });
    expect(await readBoardHtml(store, boardSession, "scoped")).toMatchObject({
      html: "one",
      grantState: "granted",
    });

    const narrower = await store.putWidget({
      ...boardSession,
      name: "scoped",
      content: { kind: "html", html: "one" },
      declared: {
        netOrigins: ["https://one.example"],
        tools: ["weather.read"],
      },
    });
    expect(narrower.widgets[0]).toMatchObject({ revision: 3, grantState: "granted" });

    const changed = await store.putWidget({
      ...boardSession,
      name: "scoped",
      content: { kind: "html", html: "two" },
      declared: {
        netOrigins: ["https://one.example"],
        tools: ["weather.read"],
      },
    });
    expect(changed.widgets[0]).toMatchObject({ revision: 4, grantState: "pending" });
    expect(await readBoardHtml(store, boardSession, "scoped")).toMatchObject({
      html: "two",
      grantState: "pending",
    });
    await store.grant(boardSession, "scoped", "granted", 4, changed.widgets[0]?.instanceId);

    const wider = await store.putWidget({
      ...boardSession,
      name: "scoped",
      content: { kind: "html", html: "two" },
      declared: {
        netOrigins: ["https://one.example", "https://three.example"],
        tools: ["weather.read"],
      },
    });
    expect(wider.widgets[0]).toMatchObject({ revision: 5, grantState: "pending" });
  });

  it("requires a fresh grant when an MCP app widget changes servers", async () => {
    const store = createStore();
    const descriptor = {
      serverName: "server-a",
      toolName: "weather",
      uiResourceUri: "ui://weather",
      toolCallId: "call-a",
    };
    const first = await store.putWidget({
      ...boardSession,
      name: "weather",
      content: { kind: "mcp-app", descriptor, interactive: true },
      declared: { tools: ["refresh"] },
    });
    await store.grant(boardSession, "weather", "granted", 1, first.widgets[0]?.instanceId);

    const differentServer = await store.putWidget({
      ...boardSession,
      name: "weather",
      content: {
        kind: "mcp-app",
        descriptor: { ...descriptor, serverName: "server-b", toolCallId: "call-b" },
        interactive: true,
      },
      declared: { tools: ["refresh"] },
    });
    expect(differentServer.widgets[0]).toMatchObject({ revision: 2, grantState: "pending" });

    await store.grant(
      boardSession,
      "weather",
      "granted",
      2,
      differentServer.widgets[0]?.instanceId,
    );
    const sameServer = await store.putWidget({
      ...boardSession,
      name: "weather",
      content: {
        kind: "mcp-app",
        descriptor: { ...descriptor, serverName: "server-b", toolCallId: "call-c" },
        interactive: true,
      },
      declared: { tools: ["refresh"] },
    });
    expect(sameServer.widgets[0]).toMatchObject({ revision: 3, grantState: "granted" });
  });

  it("rejects a delayed MCP App grant after remove and same-name replacement", async () => {
    const store = createStore();
    const putApp = async (serverName: string) =>
      await store.putWidget({
        ...boardSession,
        name: "app",
        content: {
          kind: "mcp-app",
          descriptor: {
            serverName,
            toolName: "tool",
            uiResourceUri: `ui://${serverName}`,
            toolCallId: `call-${serverName}`,
          },
          interactive: true,
        },
        declared: { tools: ["refresh"] },
      });
    const original = await putApp("server-a");
    await store.applyOps(boardSession, [{ kind: "widget_remove", name: "app" }]);
    const replacement = await putApp("server-b");

    expect(replacement.widgets[0]).toMatchObject({ revision: 1, grantState: "pending" });
    expect(replacement.widgets[0]?.instanceId).not.toBe(original.widgets[0]?.instanceId);
    await expect(
      store.grant(boardSession, "app", "granted", 1, original.widgets[0]?.instanceId),
    ).rejects.toThrow("instance changed");
    expect(
      (await store.grant(boardSession, "app", "granted", 1, replacement.widgets[0]?.instanceId))
        .widgets[0],
    ).toMatchObject({ grantState: "granted" });
  });

  it("rejects a delayed HTML grant after remove and same-name replacement", async () => {
    const store = createStore();
    const putHtml = async (html: string) =>
      await store.putWidget({
        ...boardSession,
        name: "app",
        content: { kind: "html", html },
        declared: { tools: ["refresh"] },
      });
    const original = await putHtml("original");
    await store.applyOps(boardSession, [{ kind: "widget_remove", name: "app" }]);
    const replacement = await putHtml("replacement");

    expect(replacement.widgets[0]).toMatchObject({ revision: 1, grantState: "pending" });
    expect(replacement.widgets[0]?.instanceId).not.toBe(original.widgets[0]?.instanceId);
    await expect(
      store.grant(boardSession, "app", "granted", 1, original.widgets[0]?.instanceId),
    ).rejects.toThrow("instance changed");
  });

  it("rejects stale grant revisions before accepting the current one", async () => {
    const store = createStore();
    const first = await store.putWidget({
      ...boardSession,
      name: "scoped",
      content: { kind: "html", html: "one" },
      declared: { tools: ["weather.read"] },
    });
    await expect(store.grant(boardSession, "scoped", "granted", 2)).rejects.toThrow(
      "revision changed",
    );
    expect(
      (await store.grant(boardSession, "scoped", "granted", 1, first.widgets[0]?.instanceId))
        .widgets[0],
    ).toMatchObject({
      revision: 1,
      grantState: "granted",
    });
  });

  it("drops an empty board after its last tab is deleted", async () => {
    const store = createStore();
    await store.applyOps(boardSession, [{ kind: "tab_create", tabId: "main", title: "Main" }]);
    expect(
      await store.applyOps(boardSession, [{ kind: "tab_delete", tabId: "main" }]),
    ).toMatchObject({
      revision: 2,
      tabs: [],
      widgets: [],
    });
    expect(await store.getSnapshot(boardSession)).toMatchObject({
      revision: 0,
      tabs: [],
      widgets: [],
    });
  });
});

describe("SqliteBoardStore persistence", () => {
  it("round-trips widget frame preferences through the manifest", async () => {
    const stateDir = tempDirs.make("openclaw-board-widget-frame-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:widget-frame";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    await store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "status" },
      presentation: "card",
      heightMode: "auto",
    });
    await store.applyOps({ sessionKey }, [
      { kind: "widget_resize", name: "status", sizeW: 8, sizeH: 7, heightMode: "fixed" },
    ]);

    expect((await store.getSnapshot({ sessionKey })).widgets[0]).toMatchObject({
      presentation: "card",
      heightMode: "fixed",
      sizeW: 8,
      sizeH: 7,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const readManifest = () =>
      JSON.parse(
        (
          database.db
            .prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = 'status'")
            .get(sessionKey) as { manifest: string }
        ).manifest,
      );
    expect(readManifest()).toMatchObject({ presentation: "card", heightMode: "fixed" });

    // A content re-pin that omits frame options must keep the persisted ones.
    await store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "status v2" },
    });
    expect(readManifest()).toMatchObject({ presentation: "card", heightMode: "fixed" });

    // Legacy resize ops without heightMode still pin persisted height.
    await store.applyOps({ sessionKey }, [
      { kind: "widget_resize", name: "status", sizeW: 8, sizeH: 7, heightMode: "auto" },
    ]);
    expect(readManifest()).toMatchObject({ heightMode: "auto" });
    await store.applyOps({ sessionKey }, [
      { kind: "widget_resize", name: "status", sizeW: 6, sizeH: 4 },
    ]);
    expect(readManifest()).toMatchObject({ presentation: "card", heightMode: "fixed" });
  });

  it("drops MCP App rows without canonical authority provenance", async () => {
    const stateDir = tempDirs.make("openclaw-board-noncanonical-app-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:board";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    await store.putWidget({
      sessionKey,
      name: "legacy-app",
      content: {
        kind: "mcp-app",
        descriptor: {
          serverName: "server",
          toolName: "tool",
          uiResourceUri: "ui://resource",
          toolCallId: "call",
        },
        interactive: true,
      },
      declared: { tools: ["refresh"] },
    });

    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare("UPDATE board_widgets SET manifest = '{}' WHERE session_key = ? AND name = ?")
      .run(sessionKey, "legacy-app");

    expect((await store.getSnapshot({ sessionKey })).widgets).toEqual([]);
    expect(await store.readWidgetMcpApp({ sessionKey }, "legacy-app")).toBeUndefined();
  });

  it("migrates board tables into an existing v14 database", async () => {
    const stateDir = tempDirs.make("openclaw-board-lazy-schema-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:board";
    seedSession(env, "main", sessionKey);
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const existingV14 = new DatabaseSync(databasePath);
    existingV14.exec(`
      DROP TABLE board_widgets;
      DROP TABLE board_tabs;
      DROP TABLE session_participants;
      PRAGMA user_version = 14;
      UPDATE schema_meta SET schema_version = 14 WHERE meta_key = 'primary';
    `);
    existingV14.close();

    expect((await migrateLegacyMediaPersistence({ env })).warnings).toEqual([]);

    const reopened = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'board_tabs'")
        .get(),
    ).toEqual({ name: "board_tabs" });

    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    expect(await store.getSnapshot({ sessionKey })).toMatchObject({
      revision: 0,
      tabs: [],
      widgets: [],
    });
    expect(await readBoardHtml(store, { sessionKey }, "status")).toBeUndefined();
    await expect(
      store.putWidget({
        sessionKey,
        name: "broken",
        content: { kind: "html", html: "broken" },
        placement: { tabId: "missing" },
      }),
    ).rejects.toThrow("board tab not found");
    await store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "ok" },
    });
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('board_tabs', 'board_widgets') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "board_tabs" }, { name: "board_widgets" }]);
    expect(
      reopened.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'board_widgets'")
        .get(),
    ).toEqual({ strict: 1 });
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_board_widgets_tab_position'",
        )
        .get(),
    ).toEqual({ name: "idx_agent_board_widgets_tab_position" });
  });

  it("upgrades the v14 board constraint before storing plugin widgets", async () => {
    const stateDir = tempDirs.make("openclaw-board-plugin-kind-schema-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:board";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    await store.putWidget({
      sessionKey,
      name: "existing",
      content: { kind: "html", html: "preserved" },
    });

    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const schema = opened.db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'board_widgets'")
      .get() as { sql: string };
    const legacySchema = schema.sql
      .replace(
        "content_kind IN ('html', 'mcp-app', 'plugin')",
        "content_kind IN ('html', 'mcp-app')",
      )
      .replace(
        /\s+OR\s+\(content_kind = 'plugin' AND html IS NULL AND descriptor_json IS NOT NULL AND view_generation IS NULL\)/u,
        "",
      );
    const legacyCreateSql = legacySchema.replace(
      /^CREATE TABLE board_widgets/u,
      "CREATE TABLE board_widgets_legacy",
    );
    opened.db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      ${legacyCreateSql};
      INSERT INTO board_widgets_legacy SELECT * FROM board_widgets;
      DROP TABLE board_widgets;
      ALTER TABLE board_widgets_legacy RENAME TO board_widgets;
      CREATE INDEX idx_agent_board_widgets_tab_position
        ON board_widgets(session_key, tab_id, position);
      COMMIT;
      PRAGMA foreign_keys = ON;
      DROP TABLE session_participants;
      PRAGMA user_version = 14;
      UPDATE schema_meta SET schema_version = 14 WHERE meta_key = 'primary';
    `);
    closeOpenClawAgentDatabasesForTest();

    expect((await migrateLegacyMediaPersistence({ env })).warnings).toEqual([]);

    const upgradedStore = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    expect((await upgradedStore.getSnapshot({ sessionKey })).widgets).toEqual([
      expect.objectContaining({ name: "existing", contentKind: "html" }),
    ]);
    await upgradedStore.putWidget({
      sessionKey,
      name: "plugin",
      content: { kind: "plugin", pluginKind: "workboard:card", props: { cardId: "123" } },
    });

    expect((await readBoardHtml(upgradedStore, { sessionKey }, "existing"))?.html).toBe(
      "preserved",
    );
    expect((await upgradedStore.getSnapshot({ sessionKey })).widgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "existing", contentKind: "html" }),
        expect.objectContaining({
          name: "plugin",
          contentKind: "plugin",
          pluginKind: "workboard:card",
          props: { cardId: "123" },
        }),
      ]),
    );
  });

  it("does not create an unregistered agent database during widget byte lookup", async () => {
    const stateDir = tempDirs.make("openclaw-board-no-create-");
    const store = new SqliteBoardStore({
      resolveSession: () => ({
        agentId: "attacker-selected",
        sessionKey: "agent:attacker-selected:main",
      }),
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(await store.getSnapshot({ sessionKey: "agent:attacker-selected:main" })).toEqual({
      sessionKey: "agent:attacker-selected:main",
      revision: 0,
      tabs: [],
      widgets: [],
    });
    expect(
      await readBoardHtml(store, { sessionKey: "agent:attacker-selected:main" }, "missing"),
    ).toBeUndefined();
    await expect(
      store.putWidget({
        sessionKey: "agent:attacker-selected:main",
        name: "missing",
        content: { kind: "html", html: "no" },
      }),
    ).rejects.toThrow("board session not found");
    expect(
      existsSync(
        path.join(stateDir, "agents", "attacker-selected", "agent", "openclaw-agent.sqlite"),
      ),
    ).toBe(false);
    expect(existsSync(path.join(stateDir, "agents", "attacker-selected"))).toBe(false);
  });

  it("rejects board writes for transcript-only placeholder nodes", async () => {
    const stateDir = tempDirs.make("openclaw-board-transcript-only-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:transcript-only";
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare(
        `INSERT INTO session_nodes (
           session_key, current_session_id, entry_json, updated_at
         ) VALUES (?, 'transcript-only-session', '{}', 1)`,
      )
      .run(sessionKey);
    database.db
      .prepare(
        `INSERT INTO session_windows (
           session_id, session_key, session_scope, created_at, updated_at
         ) VALUES ('transcript-only-session', ?, 'conversation', 1, 1)`,
      )
      .run(sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });

    await expect(
      store.putWidget({
        sessionKey,
        name: "status",
        content: { kind: "html", html: "no" },
      }),
    ).rejects.toThrow("board session not found");
  });

  it("canonicalizes aliases before reading and writing board rows", async () => {
    const stateDir = tempDirs.make("openclaw-board-alias-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const canonicalSessionKey = "agent:main:main";
    seedSession(env, "main", canonicalSessionKey);
    const store = new SqliteBoardStore({
      resolveSession: ({ sessionKey }) => ({
        agentId: "main",
        sessionKey: sessionKey === "main" ? canonicalSessionKey : sessionKey,
      }),
      env,
    });

    await store.putWidget({
      sessionKey: "main",
      name: "status",
      content: { kind: "html", html: "one" },
    });
    expect(await store.getSnapshot({ sessionKey: canonicalSessionKey })).toMatchObject({
      sessionKey: canonicalSessionKey,
      widgets: [{ name: "status", revision: 1 }],
    });
    await store.putWidget({
      sessionKey: canonicalSessionKey,
      name: "status",
      content: { kind: "html", html: "two" },
    });
    expect(await store.getSnapshot({ sessionKey: "main" })).toMatchObject({
      sessionKey: canonicalSessionKey,
      widgets: [{ name: "status", revision: 2 }],
    });
    expect((await readBoardHtml(store, { sessionKey: "main" }, "status"))?.html).toBe("two");
  });

  it("fails closed when reading a persisted unsafe capability manifest", async () => {
    const stateDir = tempDirs.make("openclaw-board-unsafe-manifest-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:unsafe-manifest";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    await store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "ok" },
    });

    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare(
        "UPDATE board_widgets SET manifest = ?, grant_state = 'granted', granted_sha = sha256 WHERE session_key = ? AND name = 'status'",
      )
      .run(
        JSON.stringify({ netOrigins: ["http://legacy.example"], tools: ["health"] }),
        sessionKey,
      );

    expect((await store.getSnapshot({ sessionKey })).widgets[0]).toMatchObject({
      name: "status",
      grantState: "none",
    });
    expect((await store.getSnapshot({ sessionKey })).widgets[0]).not.toHaveProperty("declared");
    expect(await readBoardHtml(store, { sessionKey }, "status")).toMatchObject({
      html: "ok",
      grantState: "none",
    });
    expect(await readBoardHtml(store, { sessionKey }, "status")).not.toHaveProperty("declared");

    database.db
      .prepare(
        "UPDATE board_widgets SET grant_state = 'rejected' WHERE session_key = ? AND name = 'status'",
      )
      .run(sessionKey);
    expect((await store.getSnapshot({ sessionKey })).widgets[0]).toMatchObject({
      name: "status",
      grantState: "rejected",
    });
    expect(await readBoardHtml(store, { sessionKey }, "status")).toMatchObject({
      html: "ok",
      grantState: "rejected",
    });
  });

  it("reads widget bytes only from the canonical per-agent database", async () => {
    const stateDir = tempDirs.make("openclaw-board-canonical-bytes-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionKey = "agent:worker-1:board";
    seedSession(env, agentId, sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId, sessionKey }),
      env,
    });
    await store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "canonical" },
    });

    const relocated = openOpenClawAgentDatabase({
      agentId,
      env,
      path: path.join(stateDir, "000-relocated.sqlite"),
    });
    replaceSessionEntrySync(
      { agentId, sessionKey, storePath: relocated.path },
      { sessionId: "relocated-session", updatedAt: Date.now() },
    );
    relocated.db
      .prepare(
        "INSERT INTO board_tabs (session_key, tab_id, title, position, chat_dock, created_by, revision) VALUES (?, 'main', 'Main', 0, 'right', 'agent', 1)",
      )
      .run(sessionKey);
    relocated.db
      .prepare(
        "INSERT INTO board_widgets (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, manifest, grant_state, created_by, created_at, updated_at) VALUES (?, 'status', 'main', 'html', ?, ?, ?, 1, 6, 4, 0, '{}', 'none', 'agent', 1, 1)",
      )
      .run(sessionKey, Buffer.from("relocated"), "a".repeat(64), "b".repeat(32));

    expect(await readBoardHtml(store, { sessionKey }, "status")).toMatchObject({
      html: "canonical",
    });
  });

  it("purges board rows through the shared session deletion lifecycle", async () => {
    const stateDir = tempDirs.make("openclaw-board-shared-delete-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:cleanup";
    const databasePath = seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    await store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "ok" },
    });

    const result = await deleteSessionEntryLifecycle({
      agentId: "main",
      archiveTranscript: false,
      storePath: databasePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    expect(result.deleted).toBe(true);
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(database.db.prepare("SELECT count(*) AS count FROM board_widgets").get()).toEqual({
      count: 0,
    });
    expect(database.db.prepare("SELECT count(*) AS count FROM board_tabs").get()).toEqual({
      count: 0,
    });
  });

  it("clears a frozen grant when the widget digest changes", async () => {
    const stateDir = tempDirs.make("openclaw-board-granted-digest-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:grant-digest";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    const first = await store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "one" },
      declared: { tools: ["status.read", "status.refresh"] },
    });
    await store.grant({ sessionKey }, "status", "granted", 1, first.widgets[0]?.instanceId);
    await store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "two" },
      declared: { tools: ["status.read"] },
    });

    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(
      database.db
        .prepare(
          "SELECT grant_state AS grantState, granted_sha AS grantedSha, sha256 FROM board_widgets WHERE session_key = ? AND name = 'status'",
        )
        .get(sessionKey),
    ).toEqual({
      grantState: "pending",
      grantedSha: null,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("requires reapproval for grants stored before byte-frozen semantics", async () => {
    const stateDir = tempDirs.make("openclaw-board-legacy-grant-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:legacy-grant";
    seedSession(env, "main", sessionKey);
    const store = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    const current = await store.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "approved" },
      declared: { tools: ["health"] },
    });
    await store.grant({ sessionKey }, "status", "granted", 1, current.widgets[0]?.instanceId);

    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare("UPDATE board_widgets SET manifest = ? WHERE session_key = ? AND name = 'status'")
      .run(JSON.stringify({ tools: ["health"] }), sessionKey);

    expect((await store.getSnapshot({ sessionKey })).widgets[0]).toMatchObject({
      grantState: "pending",
      declared: { tools: ["health"] },
    });
    expect(await readBoardHtml(store, { sessionKey }, "status")).toMatchObject({
      grantState: "pending",
      declared: { tools: ["health"] },
    });
    expect(
      (await store.grant({ sessionKey }, "status", "granted", 1, current.widgets[0]?.instanceId))
        .widgets[0],
    ).toMatchObject({ grantState: "granted" });
    expect(
      JSON.parse(
        (
          database.db
            .prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = 'status'")
            .get(sessionKey) as { manifest: string }
        ).manifest,
      ),
    ).toEqual({ contentOwner: "html", tools: ["health"], grantSemanticsVersion: 2 });
  });

  it("reopens durable boards and isolates owning agent databases", async () => {
    const stateDir = tempDirs.make("openclaw-board-durable-");
    const options = {
      resolveSession: ({ sessionKey }: { sessionKey: string }) => ({
        agentId: sessionKey.split(":")[1] ?? "main",
        sessionKey,
      }),
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    seedSession(options.env, "alpha", "agent:alpha:board");
    seedSession(options.env, "beta", "agent:beta:board");
    const store = new SqliteBoardStore(options);
    await store.putWidget({
      sessionKey: "agent:alpha:board",
      name: "alpha",
      content: { kind: "html", html: "alpha" },
    });
    await store.putWidget({
      sessionKey: "agent:beta:board",
      name: "beta",
      content: { kind: "html", html: "beta" },
    });

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const reopened = new SqliteBoardStore(options);
    expect((await reopened.getSnapshot({ sessionKey: "agent:alpha:board" })).widgets).toEqual([
      expect.objectContaining({ name: "alpha", revision: 1 }),
    ]);
    expect((await reopened.getSnapshot({ sessionKey: "agent:beta:board" })).widgets).toEqual([
      expect.objectContaining({ name: "beta", revision: 1 }),
    ]);
  });
});
