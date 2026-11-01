import { existsSync } from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type {
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { restoreEmptyV21StorageForHistoricalFixture } from "../state/openclaw-agent-schema-v21.test-support.js";
import { BoardValidationError } from "./board-layout.js";
import {
  boardFixture,
  htmlWidget,
  mcpContent,
  testBoard,
} from "./board-store.fixtures.test-support.js";
import type { BoardStore } from "./board-store.js";
import {
  closeBoardDatabases as closeDatabases,
  readBoardHtml,
  createTestBoardStore,
} from "./board-store.test-support.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeDatabases();
    cleanup();
  }),
);

async function putHtml(store: BoardStore, sessionKey: string, name: string, html = "<p>one</p>") {
  return await store.putWidget(htmlWidget(sessionKey, name, html));
}

const boardSession = { sessionKey: "agent:main:board" };
const emptySnapshot = (sessionKey: string) => ({ sessionKey, revision: 0, tabs: [], widgets: [] });
const health = { tools: ["health"] };
const instancePattern = /^[a-f0-9]{32}$/u;
const pluginContent = (props?: Record<string, unknown>) => ({
  kind: "plugin" as const,
  pluginKind: "workboard:card",
  ...(props === undefined ? {} : { props }),
});
async function expectWidget(snapshot: Promise<BoardSnapshot>, expected: Record<string, unknown>) {
  expect((await snapshot).widgets[0]).toMatchObject(expected);
}

function fixture() {
  const context = boardFixture(tempDirs.make("board-store-"));
  let store = context.store;
  const updateWidget = (set: string, values: SQLInputValue[] = [], name = "status") =>
    context.database.db
      .prepare(`UPDATE board_widgets SET ${set} WHERE session_key = ? AND name = ?`)
      .run(...values, context.sessionKey, name);
  return {
    ...context,
    html: (name: string, html: string) => putHtml(context.store, context.sessionKey, name, html),
    updateWidget,
    manifest: (name = "status") => {
      const row = openOpenClawAgentDatabase(context.options)
        .db.prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = ?")
        .get(context.sessionKey, name) as { manifest: string };
      return JSON.parse(row.manifest);
    },
    pin: (
      name: string,
      title: string,
      html: string,
      key?: string,
      fallbackName = `${name}-${key?.repeat(8)}`,
    ) =>
      store.putWidget({
        ...htmlWidget(context.sessionKey, name, html),
        title,
        generatedIdentity: key
          ? { source: "show_widget", key: key.repeat(64), fallbackName }
          : undefined,
      }),
    readHtml: (name: string) => readBoardHtml(store, context.target, name),
    current: () => store.getSnapshot(context.target),
    reopen: async () => {
      await closeDatabases();
      store = new SqliteBoardStore(context.storeOptions);
    },
    unmark: (name: string) =>
      updateWidget("manifest = json_remove(manifest, '$.nameIdentity')", [], name),
  };
}

it("releases SQLite before awaiting a widget consumer's external work", async () => {
  const { store, database, target, html } = fixture();
  await html("status", "original");
  const started = createDeferred();
  const release = createDeferred();
  const consumed = store.useWidgetDocument(target, "status", async (document) => {
    expect(database.db.isTransaction).toBe(false);
    started.resolve();
    await release.promise;
    return document;
  });
  try {
    await started.promise;
    await html("status", "replacement");
  } finally {
    release.resolve();
  }
  expect(await consumed).toMatchObject({ html: "original" });
  expect(await readBoardHtml(store, target, "status")).toMatchObject({ html: "replacement" });
});

it("rejects content-owner changes until the plugin widget is removed", async () => {
  const { put: putWidget, snapshot, ops } = testBoard();
  const put = (content: BoardWidgetMaterializedPutParams["content"]) =>
    putWidget({ name: "status", content });
  const { revision, widgets } = await put(pluginContent({ cardId: "original" }));
  expect(widgets[0]).toMatchObject({ contentOwner: "plugin" });
  for (const content of [
    { kind: "html" as const, html: "original" },
    mcpContent({ uiResourceUri: "ui://resource" }, false),
    { ...pluginContent(), pluginKind: "other:replacement" },
  ]) {
    await expect(put(content)).rejects.toMatchObject({ code: "invalid_operation" });
    expect(await snapshot()).toMatchObject({ revision, widgets });
  }
  await ops({ kind: "widget_remove", name: "status" });
  await expectWidget(put({ kind: "html", html: "replacement" }), {
    contentKind: "html",
    contentOwner: "html",
    revision: 1,
  });
});

it("enforces the board widget count and UTF-8 HTML byte limits", async () => {
  const store = createTestBoardStore();
  for (let index = 0; index < 48; index += 1) {
    await putHtml(store, "session", `widget-${index}`, "ok");
  }
  const error: unknown = await putHtml(store, "session", "widget-48", "ok").catch(
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(BoardValidationError);
  expect(error).toMatchObject({
    code: "invalid_operation",
    message: expect.stringContaining("more than 48 widgets"),
  });
  const largeStore = createTestBoardStore();
  const html = "é".repeat(5 * 1024 * 1024);
  await putHtml(largeStore, "session", "large", html);
  await expect(putHtml(largeStore, "session", "large", html + "é")).rejects.toThrow(
    "10485760 UTF-8 bytes",
  );
  expect((await readBoardHtml(largeStore, { sessionKey: "session" }, "large"))?.html).toBe(html);
});

it("isolates sessions, snapshots and metadata from callers and HTML document bodies", async () => {
  const store = createTestBoardStore();
  const target = boardSession;
  const put = (params: Omit<BoardWidgetMaterializedPutParams, "sessionKey">) =>
    store.putWidget({ ...target, ...params });
  await putHtml(store, "session-b", "b");
  await put({
    name: "status",
    content: { kind: "html", html: "x".repeat(256 * 1024) },
    declared: health,
  });
  await put({ name: "card", content: pluginContent({ series: [1, 2, 3] }) });
  const prepared = await store.getSnapshotWithHtmlViewMetadata(target);
  prepared.snapshot.tabs[0]!.title = "Changed";
  expect(prepared.htmlViewMetadata.get("status")).not.toHaveProperty("html");
  const widget = prepared.snapshot.widgets.find((item) => item.name === "status")!;
  widget.declared!.tools!.push("changed");
  prepared.snapshot.widgets.find((item) => item.name === "card")!.props!.series = [9];
  expect(prepared.htmlViewMetadata.get("status")!.declared).toEqual(health);
  const reread = await store.getSnapshotWithHtmlViewMetadata(target);
  expect(reread.snapshot.tabs[0]!.title).toBe("Main");
  expect(reread.snapshot.widgets.find((item) => item.name === "status")!.declared).toEqual(health);
  expect(reread.snapshot.widgets.find((item) => item.name === "card")!.props).toEqual({
    series: [1, 2, 3],
  });
  expect((await store.getSnapshot({ sessionKey: "session-b" })).widgets).toMatchObject([
    { name: "b" },
  ]);
  expect(await store.getSnapshot({ sessionKey: "missing" })).toEqual(
    emptySnapshot("agent:main:missing"),
  );
});

it("preserves native identity and layout through edits, reopen, and replacement", async () => {
  const { store, put, ops, current: readSnapshot, reopen, target } = fixture();
  const putCard = (name: string, props?: Record<string, unknown>) =>
    put({ name, content: pluginContent(props) });
  const props = {
    instanceId: "caller-selected",
    pluginInstanceId: "caller-selected",
  };
  const initial = await putCard("work-item", props);
  for (const name of ["left", "right"]) {
    await putCard(name, { side: name });
  }

  expect(initial.widgets[0]).toMatchObject({
    name: "work-item",
    contentKind: "plugin",
    pluginKind: "workboard:card",
    props,
    grantState: "none",
    instanceId: expect.stringMatching(instancePattern),
  });
  const instanceId = initial.widgets[0]?.instanceId;
  expect(await readBoardHtml(store, target, "work-item")).toBeUndefined();
  expect(await store.readWidgetMcpApp(target, "work-item")).toBeUndefined();

  const moved = await ops({ kind: "widget_move", name: "work-item", after: "right" });
  expect(moved.widgets.map((widget) => widget.name)).toEqual(["left", "right", "work-item"]);
  expect(moved.widgets[2]?.props).toEqual(props);
  expect(moved.widgets[2]?.instanceId).toBe(instanceId);
  const [left, right] = moved.widgets;
  const cleared = await putCard("work-item");
  expect(cleared.widgets).toEqual([
    left,
    right,
    expect.objectContaining({ instanceId, revision: 2 }),
  ]);
  expect(cleared.widgets[2]).not.toHaveProperty("props");
  const edited = await put({
    name: "work-item",
    title: "Updated status",
    content: pluginContent(props),
    placement: { after: "left" },
  });
  expect(edited.widgets).toEqual([
    left,
    expect.objectContaining({ title: "Updated status", instanceId, revision: 3, props }),
    { ...right, position: 2 },
  ]);
  const resized = await ops({ kind: "widget_resize", name: "work-item", sizeW: 8, sizeH: 6 });
  await reopen();
  const persisted = await readSnapshot();
  expect(persisted).toEqual(resized);
  expect(persisted.widgets[1]).toMatchObject({ sizeW: 8, sizeH: 6 });
  expect((await store.getSnapshotWithHtmlViewMetadata(target)).htmlViewMetadata.size).toBe(0);
  await ops({ kind: "widget_remove", name: "work-item" });
  const replacement = await put({ name: "work-item", content: pluginContent() });
  expect(replacement.widgets[2]?.instanceId).toMatch(instancePattern);
  expect(replacement.widgets[2]?.instanceId).not.toBe(instanceId);
});

it.each([
  [
    { name: "too-large", content: pluginContent({ value: "x".repeat(8 * 1024) }) },
    "props exceed 8192 UTF-8 bytes",
  ],
  [
    { name: "declared", content: pluginContent(), declared: health },
    "do not accept sandbox capability declarations",
  ],
] as const)("rejects invalid plugin widget %j", async (params, message) => {
  await expect(testBoard().put(params)).rejects.toThrow(message);
});
it("places MCP apps in their tab and reapproves only a changed server", async () => {
  const { store, put, ops, snapshot, app, grant } = testBoard();
  await ops(
    { kind: "tab_create", tabId: "main", title: "Main" },
    { kind: "tab_create", tabId: "notes", title: "Notes" },
  );
  await putHtml(store, boardSession.sessionKey, "first", "first");
  const first = await put({
    name: "app",
    content: mcpContent({
      serverName: "server-a",
      toolCallId: "call-a",
      uiResourceUri: "ui://resource",
    }),
    placement: { tabId: "notes" },
    declared: { tools: ["refresh"] },
  });
  expect((await snapshot()).widgets).toEqual([
    expect.objectContaining({ name: "first", tabId: "main", position: 0 }),
    expect.objectContaining({ name: "app", tabId: "notes", position: 0 }),
  ]);
  expect(await readBoardHtml(store, boardSession, "app")).toBeUndefined();
  expect(await app()).toMatchObject({
    descriptor: { uiResourceUri: "ui://resource" },
    revision: 1,
    instanceId: expect.stringMatching(instancePattern),
    interactive: true,
  });
  const putApp = (serverName: string, toolCallId: string) =>
    put({
      name: "app",
      content: mcpContent({ serverName, toolCallId }),
      declared: { tools: ["refresh"] },
    });
  await grant("app", 1, first.widgets[1]!.instanceId);
  const changed = await putApp("server-b", "call-b");
  expect(changed.widgets[1]).toMatchObject({ revision: 2, grantState: "pending" });
  await grant("app", 2, changed.widgets[1]!.instanceId);
  expect((await putApp("server-b", "call-c")).widgets[1]).toMatchObject({
    revision: 3,
    grantState: "granted",
  });
});

it("preserves HTML grants only for unchanged bytes with equal or narrower declarations", async () => {
  const documentContent = (html: string) => ({ kind: "html" as const, html });
  const { put: putWidget, grant, document } = testBoard();
  const wide = {
    netOrigins: ["https://one.example", "https://two.example"],
    tools: ["weather.read", "weather.refresh"],
  };
  const narrow = { netOrigins: ["https://one.example"], tools: ["weather.read"] };
  const put = (text: string, declared = narrow) =>
    putWidget({ name: "scoped", content: documentContent(text), declared });
  const first = await put("one", wide);
  expect(first.widgets[0]!.grantState).toBe("pending");
  const stale: unknown = await grant("scoped", 2).catch((error: unknown) => error);
  expect(stale).toBeInstanceOf(BoardValidationError);
  expect(stale).toMatchObject({
    code: "conflict",
    message: expect.stringContaining("revision changed"),
  });
  await expectWidget(grant("scoped", 1, first.widgets[0]?.instanceId), {
    grantState: "granted",
    revision: 1,
  });
  await expect(grant("scoped", 1, first.widgets[0]?.instanceId, "rejected")).rejects.toThrow(
    "not pending",
  );

  await expectWidget(put("one", wide), { revision: 2, grantState: "granted" });
  expect(await document("scoped")).toMatchObject({ html: "one", grantState: "granted" });

  await expectWidget(put("one"), { revision: 3, grantState: "granted" });

  const changed = await put("two");
  expect(changed.widgets[0]).toMatchObject({ revision: 4, grantState: "pending" });
  expect(await document("scoped")).toMatchObject({ html: "two", grantState: "pending" });
  await grant("scoped", 4, changed.widgets[0]?.instanceId);

  await expectWidget(
    put("two", { ...narrow, netOrigins: ["https://one.example", "https://three.example"] }),
    { revision: 5, grantState: "pending" },
  );
});

it.each(["html", "mcp-app"] as const)(
  "rejects a delayed %s grant after same-name replacement",
  async (kind) => {
    const { put, grant, ops } = testBoard();
    const putApp = (value: string) =>
      put({
        name: "app",
        content:
          kind === "html"
            ? { kind, html: value }
            : mcpContent({
                serverName: value,
                uiResourceUri: `ui://${value}`,
                toolCallId: `call-${value}`,
              }),
        declared: { tools: ["refresh"] },
      });
    const original = await putApp("server-a");
    await ops({ kind: "widget_remove", name: "app" });
    const replacement = await putApp("server-b");

    expect(replacement.widgets[0]).toMatchObject({ revision: 1, grantState: "pending" });
    expect(replacement.widgets[0]?.instanceId).not.toBe(original.widgets[0]?.instanceId);
    await expect(grant("app", 1, original.widgets[0]?.instanceId)).rejects.toThrow(
      "instance changed",
    );
    await expectWidget(grant("app", 1, replacement.widgets[0]?.instanceId), {
      grantState: "granted",
    });
  },
);
it("drops MCP App rows without canonical authority provenance", async () => {
  const { sessionKey, snapshot, store, put, updateWidget } = fixture();
  await put({
    name: "legacy-app",
    content: mcpContent({ uiResourceUri: "ui://resource" }),
    declared: { tools: ["refresh"] },
  });

  updateWidget("manifest = '{}'", [], "legacy-app");

  expect((await snapshot()).widgets).toEqual([]);
  expect(await store.readWidgetMcpApp({ sessionKey }, "legacy-app")).toBeUndefined();
});

it("migrates board tables into an existing v14 database", async () => {
  const { env, sessionKey, database: opened } = fixture();
  const databasePath = opened.path;
  await closeDatabases();

  const { DatabaseSync } = requireNodeSqlite();
  const existingV14 = new DatabaseSync(databasePath);
  restoreEmptyV21StorageForHistoricalFixture(existingV14);
  removeCanonicalValidationFromHistoricalAgentFixture(existingV14);
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

  const store = new SqliteBoardStore({
    resolveSession: () => ({ agentId: "main", sessionKey }),
    env,
  });
  expect(await store.getSnapshot({ sessionKey })).toEqual(emptySnapshot(sessionKey));
  expect(await readBoardHtml(store, { sessionKey }, "status")).toBeUndefined();
  await expect(
    store.putWidget({
      ...htmlWidget(sessionKey, "broken", "broken"),
      placement: { tabId: "missing" },
    }),
  ).rejects.toThrow("board tab not found");
  await putHtml(store, sessionKey, "status", "ok");
  expect(await readBoardHtml(store, { sessionKey }, "status")).toMatchObject({ html: "ok" });
  expect(
    reopened.db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'board_widgets'").get(),
  ).toEqual({ strict: 1 });
});

it("does not create an unregistered agent database during widget byte lookup", async () => {
  const stateDir = tempDirs.make("openclaw-board-no-create-");
  const agentId = "attacker-selected";
  const sessionKey = "agent:attacker-selected:main";
  const target = { sessionKey };
  const store = new SqliteBoardStore({
    resolveSession: () => ({ agentId, sessionKey }),
    env: { OPENCLAW_STATE_DIR: stateDir },
  });

  expect(await store.getSnapshot(target)).toEqual(emptySnapshot(sessionKey));
  expect(await readBoardHtml(store, target, "missing")).toBeUndefined();
  await expect(putHtml(store, sessionKey, "missing", "no")).rejects.toThrow(
    "board session not found",
  );
  expect(existsSync(path.join(stateDir, "agents", agentId))).toBe(false);
});

it("rejects board writes for transcript-only placeholder nodes", async () => {
  const { env, sessionKey, database, html } = fixture();
  await deleteSessionEntryLifecycle({
    env,
    storePath: database.path,
    archiveTranscript: false,
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
  });
  await expect(html("status", "no")).rejects.toThrow("board session not found");
});

it("fails closed when reading a persisted unsafe capability manifest", async () => {
  const { snapshot, document, updateWidget, html } = fixture();
  await html("status", "ok");
  updateWidget("manifest = ?, grant_state = 'granted', granted_sha = sha256", [
    JSON.stringify({ netOrigins: ["http://legacy.example"], tools: ["health"] }),
  ]);

  const widget = (await snapshot()).widgets[0];
  const content = await document("status");
  expect(widget).toMatchObject({ name: "status", grantState: "none" });
  expect(widget).not.toHaveProperty("declared");
  expect(content).toMatchObject({ html: "ok", grantState: "none" });
  expect(content).not.toHaveProperty("declared");

  updateWidget("grant_state = 'rejected'");
  await expectWidget(snapshot(), { name: "status", grantState: "rejected" });
  expect(await document("status")).toMatchObject({ html: "ok", grantState: "rejected" });
});

it("reads widget bytes only from the canonical per-agent database", async () => {
  const stateDir = tempDirs.make("openclaw-board-canonical-bytes-");
  const agentId = "worker-1";
  const { env, sessionKey, store } = boardFixture(stateDir, "agent:worker-1:board", agentId);
  await putHtml(store, sessionKey, "status", "canonical");

  const relocated = openOpenClawAgentDatabase({
    agentId,
    env,
    path: path.join(stateDir, "000-relocated.sqlite"),
  });
  replaceSessionEntrySync(
    { agentId, env, sessionKey, storePath: relocated.path },
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

  expect(await readBoardHtml(store, { sessionKey }, "status")).toMatchObject({ html: "canonical" });
});

it("requires reapproval for grants stored before byte-frozen semantics", async () => {
  const { put, grant, snapshot, document, manifest, updateWidget } = fixture();
  const current = await put({
    name: "status",
    content: { kind: "html", html: "approved" },
    declared: health,
  });
  await grant("status", 1, current.widgets[0]?.instanceId);

  updateWidget("manifest = ?", [JSON.stringify(health)]);

  await expectWidget(snapshot(), { grantState: "pending", declared: health });
  expect(await document("status")).toMatchObject({ grantState: "pending", declared: health });
  await expectWidget(grant("status", 1, current.widgets[0]?.instanceId), {
    grantState: "granted",
    declared: health,
  });
  expect(manifest().grantSemanticsVersion).toBe(2);
});
it("persists explicit ownership after generated takeover", async () => {
  const { pin, readHtml: html, reopen } = fixture();
  await pin("status", "Status", "generated", "c");
  await pin("status", "Status", "manual");
  expect((await pin("status", "Status", "generated", "c")).resolvedWidgetName).toBe(
    "status-cccccccc",
  );
  expect((await html("status"))?.html).toContain("manual");
  await reopen();
  expect(await pin("status", "Status", "generated", "c")).toMatchObject({
    resolvedWidgetName: "status-cccccccc",
    widgets: [{ name: "status" }, { name: "status-cccccccc" }],
  });
  expect((await html("status"))?.html).toContain("manual");
});

it("fails closed instead of overwriting an occupied deterministic fallback", async () => {
  const { pin, current: snapshot } = fixture();
  await pin("status", "Manual", "manual");
  await pin("status-dddddddd", "Reserved", "reserved");
  await expect(pin("status", "Generated", "generated", "d")).rejects.toThrow(
    "generated widget fallback name is already in use",
  );
  expect((await snapshot()).widgets).toHaveLength(2);
});

it("rejects a fallback that is not distinct even on an empty board", async () => {
  await expect(fixture().pin("status", "Status", "generated", "f", "status")).rejects.toThrow(
    "generated widget fallback name must differ from its preferred name",
  );
});

it("preserves a beta.5-format unmarked explicit row and reuses the generated fallback", async () => {
  const board = fixture();
  await board.pin("anchor", "Anchor", "anchor");
  const legacy = await board.put({
    name: "cafe-menu",
    title: "Café Menu",
    content: { kind: "html", html: "approved" },
    declared: { tools: ["menu.refresh"] },
  });
  await board.grant("cafe-menu", 1, legacy.widgets[1]!.instanceId);
  await board.ops({ kind: "widget_resize", name: "cafe-menu", sizeW: 8, sizeH: 6 });
  board.unmark("cafe-menu");
  await board.reopen();
  const generated = await board.pin("cafe-menu", "Cafe\u0301 Menu", "generated", "e");
  const preserved = {
    name: "cafe-menu",
    revision: 1,
    grantState: "granted",
    sizeW: 8,
    sizeH: 6,
    position: 1,
  };
  expect(generated.resolvedWidgetName).toBe("cafe-menu-eeeeeeee");
  expect(generated.widgets.find(({ name }) => name === "cafe-menu")).toMatchObject(preserved);
  await board.reopen();
  const reused = await board.pin("cafe-menu", "Café Menu", "generated revised", "e");
  expect(reused.resolvedWidgetName).toBe("cafe-menu-eeeeeeee");
  expect(reused.widgets.find(({ name }) => name === "cafe-menu-eeeeeeee")).toMatchObject({
    revision: 2,
  });
  await board.reopen();
  expect((await board.current()).widgets.find(({ name }) => name === "cafe-menu")).toMatchObject(
    preserved,
  );
  expect((await board.readHtml("cafe-menu"))?.html).toContain("approved");
});
