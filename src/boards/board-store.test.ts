import { constants, copyFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardWidgetMaterializedPutParams } from "../../packages/gateway-protocol/src/index.js";
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
  closeBoardDatabases as closeDatabases,
  htmlWidget,
  mcpContent,
  testBoard,
} from "./board-store.fixtures.test-support.js";
import { createBoardWidgetPutSnapshot, type BoardStore } from "./board-store.js";
import { readBoardHtml, createTestBoardStore } from "./board-store.test-support.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";
import { readBoardSnapshotWithHtmlViewMetadata } from "./sqlite-board-store.kernel.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeDatabases();
    cleanup();
  }),
);

async function putHtml(store: BoardStore, sessionKey: string, name: string, html = "<p>one</p>") {
  return await store.putWidget(htmlWidget(sessionKey, name, html));
}

const widgetContents = [
  { kind: "html", html: "<p>original</p>" },
  { kind: "plugin", pluginKind: "workboard:card", props: { cardId: "original" } },
  {
    kind: "registered",
    contentKind: "diagram",
    pluginKind: "diagram:diagram",
    source: "diagram:original",
  },
  mcpContent({ uiResourceUri: "ui://resource" }, false),
] satisfies BoardWidgetMaterializedPutParams["content"][];
const boardSession = { sessionKey: "agent:main:board" };

it("releases SQLite before awaiting a widget consumer's external work", async () => {
  const { store, database, target } = boardFixture(tempDirs.make("board-consume-"));
  await putHtml(store, target.sessionKey, "status", "original");
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
    await putHtml(store, target.sessionKey, "status", "replacement");
  } finally {
    release.resolve();
  }
  expect(await consumed).toMatchObject({ html: "original" });
  expect(await readBoardHtml(store, target, "status")).toMatchObject({ html: "replacement" });
});

it.each(
  widgetContents.filter((content) => content.kind === "plugin" || content.kind === "registered"),
)("preserves $kind widget ownership across same-name updates", async (content) => {
  const store = createTestBoardStore();
  const name = `${content.kind}-status`;
  const put = (replacement: BoardWidgetMaterializedPutParams["content"]) =>
    store.putWidget({ sessionKey: "session", name, content: replacement });
  const created = await put(content);
  const expectUnchanged = async () =>
    expect(await store.getSnapshot({ sessionKey: "session" })).toMatchObject({
      revision: created.revision,
      widgets: created.widgets,
    });
  expect(created.widgets[0]?.instanceId).toMatch(/^[a-f0-9]{32}$/u);

  expect(created.widgets[0]).toMatchObject({
    contentOwner: content.kind,
    ...(content.kind === "registered" ? { registeredContentKind: content.contentKind } : {}),
  });

  for (const replacement of widgetContents.filter((candidate) => candidate.kind !== content.kind)) {
    await expect(put(replacement)).rejects.toThrow(
      expect.objectContaining({
        code: "invalid_operation",
        message: expect.stringMatching(/same content kind.*remove/i),
      }),
    );
    await expectUnchanged();
  }

  await expect(put({ ...content, pluginKind: "other:replacement" })).rejects.toThrow(
    expect.objectContaining({ code: "invalid_operation" }),
  );
  await expectUnchanged();

  if (content.kind === "registered") {
    await expect(put({ ...content, contentKind: "alternate" })).rejects.toThrow(
      expect.objectContaining({ code: "invalid_operation" }),
    );
    await expectUnchanged();
  }

  if (content.kind === "plugin") {
    const withIncidentalInstance = {
      ...created,
      widgets: created.widgets.map((widget) => ({ ...widget, instanceId: "incidental" })),
    };
    expect(
      createBoardWidgetPutSnapshot(
        withIncidentalInstance,
        { sessionKey: created.sessionKey, name, content },
        { grantScopeMatches: true, instanceId: "replacement" },
      ).widgets[0],
    ).toMatchObject({ contentOwner: "plugin", revision: 2 });
  }

  const updated = (await put(content)).widgets[0]!;
  expect(updated).toMatchObject({ name, revision: 2 });
  if (content.kind === "plugin") {
    expect(updated.instanceId).toBe(created.widgets[0]?.instanceId);
  } else {
    expect(updated.instanceId).not.toBe(created.widgets[0]?.instanceId);
  }
  expect((await store.getSnapshot({ sessionKey: "session" })).widgets[0]?.instanceId).toBe(
    updated.instanceId,
  );

  await store.applyOps({ sessionKey: "session" }, [{ kind: "widget_remove", name }]);
  const replacement = widgetContents.find((candidate) => candidate.kind !== content.kind)!;
  expect((await put(replacement)).widgets[0]).toMatchObject({
    contentKind: replacement.kind === "registered" ? "plugin" : replacement.kind,
    contentOwner: replacement.kind,
    revision: 1,
  });
});

it("enforces the board widget count and UTF-8 HTML byte limits", async () => {
  const store = createTestBoardStore();
  for (let index = 0; index < 48; index += 1) {
    await putHtml(store, "session", `widget-${index}`, "ok");
  }
  try {
    await putHtml(store, "session", "widget-48", "ok");
    throw new Error("expected widget cap to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(BoardValidationError);
    expect(error).toMatchObject({ code: "invalid_operation" });
    expect((error as Error).message).toContain("more than 48 widgets");
  }
  const largeStore = createTestBoardStore();
  const html = "é".repeat(5 * 1024 * 1024);
  await putHtml(largeStore, "session", "large", html);
  await expect(putHtml(largeStore, "session", "large", html + "é")).rejects.toThrow(
    "10485760 UTF-8 bytes",
  );
  expect((await readBoardHtml(largeStore, { sessionKey: "session" }, "large"))?.html).toBe(html);
});

it("upgrades registered ownership from its exact legacy descriptor and preserves it", async () => {
  const { sessionKey, put, snapshot, grant, database } = boardFixture(
    tempDirs.make("board-legacy-registered-"),
  );
  const content = {
    kind: "registered" as const,
    contentKind: "diagram",
    pluginKind: "diagram:diagram",
    source: "diagram:first",
  };
  await put({ name: "status", content, declared: { tools: ["health"] } });
  database.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_set(manifest, '$.registeredContentKind', 'other') WHERE session_key = ? AND name = 'status'",
    )
    .run(sessionKey);
  await expect(snapshot()).rejects.toThrow(/content ownership/i);
  database.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_remove(manifest, '$.contentOwner', '$.registeredContentKind', '$.registeredInstanceId') WHERE session_key = ? AND name = 'status'",
    )
    .run(sessionKey);

  const legacy = (await snapshot()).widgets[0]!;
  expect(legacy).toMatchObject({ contentOwner: "registered", registeredContentKind: "diagram" });
  expect(legacy).not.toHaveProperty("instanceId");
  await expect(
    put({ name: "status", content: { kind: "plugin", pluginKind: "diagram:diagram" } }),
  ).rejects.toThrow(/same content kind.*remove/i);
  await expect(
    put({ name: "status", content: { ...content, contentKind: "other" } }),
  ).rejects.toThrow(/same content kind.*remove/i);

  const refreshed = await put({
    name: "status",
    content: { ...content, source: "diagram:refreshed" },
    declared: { tools: ["health"] },
  });
  await grant("status", 2, refreshed.widgets[0]?.instanceId);
  const row = database.db
    .prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = 'status'")
    .get(sessionKey) as { manifest: string };
  expect(JSON.parse(row.manifest)).toMatchObject({
    contentOwner: "registered",
    registeredContentKind: "diagram",
    grantSemanticsVersion: 2,
  });
});

it("returns immutable snapshots and isolates session boards", async () => {
  const store = createTestBoardStore();
  await putHtml(store, "session-b", "b");
  await putHtml(store, "session-a", "a");
  const snapshot = await store.getSnapshot({ sessionKey: "session-a" });
  snapshot.tabs[0]!.title = "Changed";
  const current = await store.getSnapshot({ sessionKey: "session-a" });
  expect(current).toMatchObject({ tabs: [{ title: "Main" }], widgets: [{ name: "a" }] });
  expect((await store.getSnapshot({ sessionKey: "session-b" })).widgets).toMatchObject([
    { name: "b" },
  ]);
  expect(await store.getSnapshot({ sessionKey: "missing" })).toEqual({
    sessionKey: "agent:main:missing",
    revision: 0,
    tabs: [],
    widgets: [],
  });
});

it("transitions declared widgets through pending grants", async () => {
  const { put, grant } = testBoard("session");
  const pending = await put({
    name: "networked",
    content: { kind: "html", html: "<p>ok</p>" },
    declared: { netOrigins: ["https://example.com"] },
  });
  expect(pending.widgets[0]!.grantState).toBe("pending");
  const instance = pending.widgets[0]?.instanceId;
  expect((await grant("networked", 1, instance)).widgets[0]!.grantState).toBe("granted");
  await expect(grant("networked", 1, instance, "rejected")).rejects.toThrow("not pending");
});

it("rejects stale grant revisions and accepts the current revision", async () => {
  const { put, grant } = testBoard("session");
  const pending = await put({
    name: "networked",
    content: { kind: "html", html: "ok" },
    declared: { tools: ["weather.refresh"] },
  });
  const failure: unknown = await grant("networked", 2).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(BoardValidationError);
  expect(failure).toMatchObject({
    code: "conflict",
    message: expect.stringContaining("revision changed"),
  });
  const granted = await grant("networked", 1, pending.widgets[0]?.instanceId);
  expect(granted.widgets[0]).toMatchObject({ grantState: "granted", revision: 1 });
});
it("does not select the HTML BLOB when preparing board view metadata", async () => {
  const stateDir = tempDirs.make("openclaw-board-projection-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const sessionKey = "agent:main:projection";
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const store = createTestBoardStore({ stateDir });
  await store.putWidget({
    sessionKey,
    name: "status",
    content: { kind: "html", html: "x".repeat(256 * 1024) },
  });
  const prepare = vi.spyOn(database.db, "prepare");

  const prepared = readBoardSnapshotWithHtmlViewMetadata(database, sessionKey);

  const widgetSelects = prepare.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => /select .* from "board_widgets"/iu.test(sql));
  expect(widgetSelects).toHaveLength(1);
  expect(widgetSelects[0]).toContain('"sha256"');
  expect(widgetSelects[0]).not.toContain('"html"');
  expect(prepared?.htmlViewMetadata.get("status")).not.toHaveProperty("html");
  prepare.mockRestore();
  expect(await store.getSnapshotWithHtmlViewMetadata({ sessionKey })).toEqual(prepared);
});

describe("SqliteBoardStore native widgets", () => {
  it("replaces omitted plugin props without changing unrelated layout state", async () => {
    const store = createTestBoardStore();
    const putCard = (
      name: string,
      props?: Record<string, unknown>,
      placement?: BoardWidgetMaterializedPutParams["placement"],
    ) =>
      store.putWidget({
        ...boardSession,
        name,
        content: {
          kind: "plugin",
          pluginKind: "workboard:card",
          ...(props === undefined ? {} : { props }),
        },
        ...(placement ? { placement } : {}),
      });
    const initial = await putCard("work-item", { cardId: "card-123", compact: true });
    for (const name of ["left", "right"]) {
      await putCard(name, { side: name });
    }

    expect(initial.widgets[0]).toMatchObject({
      name: "work-item",
      contentKind: "plugin",
      pluginKind: "workboard:card",
      props: { cardId: "card-123", compact: true },
      grantState: "none",
    });
    const instanceId = initial.widgets[0]?.instanceId;
    expect(instanceId).toMatch(/^[a-f0-9]{32}$/u);
    expect(await readBoardHtml(store, boardSession, "work-item")).toBeUndefined();
    expect(await store.readWidgetMcpApp(boardSession, "work-item")).toBeUndefined();

    const moved = await store.applyOps(boardSession, [
      { kind: "widget_move", name: "work-item", after: "right" },
    ]);
    expect(moved.widgets.map((widget) => widget.name)).toEqual(["left", "right", "work-item"]);
    expect(moved.widgets[2]?.props).toEqual({ cardId: "card-123", compact: true });
    expect(moved.widgets[2]?.instanceId).toBe(instanceId);
    const [left, right] = moved.widgets;

    for (const [after, index, names, neighbors] of [
      [undefined, 2, ["left", "right", "work-item"], [left, right]],
      ["left", 1, ["left", "work-item", "right"], [left, { ...right, position: 2 }]],
    ] as const) {
      const { resolvedWidgetName, ...snapshot } = await putCard(
        "work-item",
        undefined,
        after ? { after } : undefined,
      );
      expect(snapshot.widgets.map(({ name }) => name)).toEqual(names);
      expect(snapshot.widgets.filter((_, position) => position !== index)).toEqual(neighbors);
      expect(snapshot.widgets[index]).not.toHaveProperty("props");
      expect(snapshot.widgets[index]?.instanceId).toBe(instanceId);
      expect(resolvedWidgetName).toBe("work-item");
      expect(await store.getSnapshot(boardSession)).toEqual(snapshot);
    }
  });

  it("rejects oversized plugin props and capability declarations", async () => {
    const store = createTestBoardStore();
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

  it("keeps native widget identity across edits and reopen, but renews it after removal", async () => {
    const stateDir = tempDirs.make("openclaw-board-plugin-identity-");
    const store = createTestBoardStore({ stateDir });
    const target = { sessionKey: "agent:main:native-identity" };
    const content = { kind: "plugin" as const, pluginKind: "workboard:card" };
    const initial = await store.putWidget({ ...target, name: "status", content });
    const instanceId = initial.widgets[0]?.instanceId;
    expect(instanceId).toMatch(/^[a-f0-9]{32}$/u);

    const edited = await store.putWidget({
      ...target,
      name: "status",
      title: "Updated status",
      content: {
        ...content,
        props: { instanceId: "caller-selected", pluginInstanceId: "caller-selected" },
      },
    });
    expect(edited.widgets[0]).toMatchObject({ title: "Updated status", instanceId });
    await store.applyOps(target, [{ kind: "widget_resize", name: "status", sizeW: 8, sizeH: 6 }]);

    await closeDatabases();
    const reopened = createTestBoardStore({ stateDir });
    expect((await reopened.getSnapshot(target)).widgets[0]).toMatchObject({
      title: "Updated status",
      instanceId,
      sizeW: 8,
      sizeH: 6,
    });
    expect((await reopened.getSnapshotWithHtmlViewMetadata(target)).htmlViewMetadata.size).toBe(0);

    await reopened.applyOps(target, [{ kind: "widget_remove", name: "status" }]);
    const replacement = await reopened.putWidget({ ...target, name: "status", content });
    expect(replacement.widgets[0]?.instanceId).toMatch(/^[a-f0-9]{32}$/u);
    expect(replacement.widgets[0]?.instanceId).not.toBe(instanceId);
    expect((await reopened.getSnapshot(target)).widgets[0]).toEqual(replacement.widgets[0]);
  });
});

describe("SqliteBoardStore behavior", () => {
  it("keeps content-kind semantics and normalized ordering", async () => {
    const store = createTestBoardStore();
    await store.applyOps(boardSession, [
      { kind: "tab_create", tabId: "main", title: "Main" },
      { kind: "tab_create", tabId: "notes", title: "Notes" },
    ]);
    await putHtml(store, boardSession.sessionKey, "first", "first");
    await store.putWidget({
      ...boardSession,
      name: "app",
      content: mcpContent({ uiResourceUri: "ui://resource" }),
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

  it.each(["html", "registered"] as const)(
    "preserves %s grants only for unchanged bytes with equal or narrower declarations",
    async (kind) => {
      const documentContent = (text: string) =>
        kind === "html"
          ? { kind, html: text }
          : { kind, contentKind: "diagram", pluginKind: "diagram:diagram", source: text };
      const { put: putWidget, grant, document } = testBoard();
      const wide = {
        netOrigins: ["https://one.example", "https://two.example"],
        tools: ["weather.read", "weather.refresh"],
      };
      const narrow = { netOrigins: ["https://one.example"], tools: ["weather.read"] };
      const put = (text: string, declared = narrow) =>
        putWidget({
          name: "scoped",
          content: documentContent(text),
          declared,
        });
      const first = await put("one", wide);
      await grant("scoped", 1, first.widgets[0]?.instanceId);

      const equal = await put("one", wide);
      expect(equal.widgets[0]).toMatchObject({ revision: 2, grantState: "granted" });
      expect(await document("scoped")).toMatchObject({
        [kind === "html" ? "html" : "source"]: "one",
        grantState: "granted",
      });

      const narrower = await put("one");
      expect(narrower.widgets[0]).toMatchObject({ revision: 3, grantState: "granted" });

      const changed = await put("two");
      expect(changed.widgets[0]).toMatchObject({ revision: 4, grantState: "pending" });
      expect(await document("scoped")).toMatchObject({
        [kind === "html" ? "html" : "source"]: "two",
        grantState: "pending",
      });
      await grant("scoped", 4, changed.widgets[0]?.instanceId);

      const wider = await put("two", {
        ...narrow,
        netOrigins: ["https://one.example", "https://three.example"],
      });
      expect(wider.widgets[0]).toMatchObject({ revision: 5, grantState: "pending" });
    },
  );

  it("requires a fresh grant when an MCP app widget changes servers", async () => {
    const { put: putWidget, grant } = testBoard();
    const put = (serverName: string, toolCallId: string) =>
      putWidget({
        name: "weather",
        content: mcpContent({ serverName, toolCallId }),
        declared: { tools: ["refresh"] },
      });
    const first = await put("server-a", "call-a");
    await grant("weather", 1, first.widgets[0]?.instanceId);

    const differentServer = await put("server-b", "call-b");
    expect(differentServer.widgets[0]).toMatchObject({ revision: 2, grantState: "pending" });

    await grant("weather", 2, differentServer.widgets[0]?.instanceId);
    const sameServer = await put("server-b", "call-c");
    expect(sameServer.widgets[0]).toMatchObject({ revision: 3, grantState: "granted" });
  });

  it("rejects a delayed MCP App grant after remove and same-name replacement", async () => {
    const { put, grant, ops } = testBoard();
    const putApp = async (serverName: string) =>
      await put({
        name: "app",
        content: mcpContent({
          serverName,
          uiResourceUri: `ui://${serverName}`,
          toolCallId: `call-${serverName}`,
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
    expect((await grant("app", 1, replacement.widgets[0]?.instanceId)).widgets[0]).toMatchObject({
      grantState: "granted",
    });
  });
  it("rejects a delayed HTML grant after remove and same-name replacement", async () => {
    const store = createTestBoardStore();
    const putDeclaredHtml = async (html: string) =>
      await store.putWidget({
        ...boardSession,
        name: "app",
        content: { kind: "html", html },
        declared: { tools: ["refresh"] },
      });
    const original = await putDeclaredHtml("original");
    await store.applyOps(boardSession, [{ kind: "widget_remove", name: "app" }]);
    const replacement = await putDeclaredHtml("replacement");

    expect(replacement.widgets[0]).toMatchObject({ revision: 1, grantState: "pending" });
    expect(replacement.widgets[0]?.instanceId).not.toBe(original.widgets[0]?.instanceId);
    await expect(
      store.grant(boardSession, "app", "granted", 1, original.widgets[0]?.instanceId),
    ).rejects.toThrow("instance changed");
  });
});

describe("SqliteBoardStore persistence", () => {
  it("drops MCP App rows without canonical authority provenance", async () => {
    const { sessionKey, store, database } = boardFixture(
      tempDirs.make("openclaw-board-noncanonical-app-"),
    );
    await store.putWidget({
      sessionKey,
      name: "legacy-app",
      content: mcpContent({ uiResourceUri: "ui://resource" }),
      declared: { tools: ["refresh"] },
    });

    database.db
      .prepare("UPDATE board_widgets SET manifest = '{}' WHERE session_key = ? AND name = ?")
      .run(sessionKey, "legacy-app");

    expect((await store.getSnapshot({ sessionKey })).widgets).toEqual([]);
    expect(await store.readWidgetMcpApp({ sessionKey }, "legacy-app")).toBeUndefined();
  });

  it("migrates board tables into an existing v14 database", async () => {
    const {
      env,
      sessionKey,
      database: opened,
    } = boardFixture(tempDirs.make("openclaw-board-lazy-schema-"));
    const databasePath = opened.path;
    await closeDatabases();

    renameSync(databasePath, `${databasePath}.template`);
    copyFileSync(`${databasePath}.template`, databasePath, constants.COPYFILE_EXCL);
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
    const row = (sql: string) => reopened.db.prepare(sql).get();
    expect(
      row("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'board_tabs'"),
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
    await putHtml(store, sessionKey, "status", "ok");
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('board_tabs', 'board_widgets') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "board_tabs" }, { name: "board_widgets" }]);
    expect(row("SELECT strict FROM pragma_table_list WHERE name = 'board_widgets'")).toEqual({
      strict: 1,
    });
    expect(
      row(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_board_widgets_tab_position'",
      ),
    ).toEqual({ name: "idx_agent_board_widgets_tab_position" });
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

    expect(await store.getSnapshot(target)).toEqual({
      sessionKey,
      revision: 0,
      tabs: [],
      widgets: [],
    });
    expect(await readBoardHtml(store, target, "missing")).toBeUndefined();
    await expect(putHtml(store, sessionKey, "missing", "no")).rejects.toThrow(
      "board session not found",
    );
    expect(existsSync(path.join(stateDir, "agents", agentId))).toBe(false);
  });

  it("rejects board writes for transcript-only placeholder nodes", async () => {
    const { env, sessionKey, store, database } = boardFixture(tempDirs.make("board-transcript-"));
    await deleteSessionEntryLifecycle({
      env,
      storePath: database.path,
      archiveTranscript: false,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    await expect(putHtml(store, sessionKey, "status", "no")).rejects.toThrow(
      "board session not found",
    );
  });

  it("fails closed when reading a persisted unsafe capability manifest", async () => {
    const { sessionKey, store, database } = boardFixture(tempDirs.make("board-unsafe-manifest-"));
    await putHtml(store, sessionKey, "status", "ok");
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

    expect(await readBoardHtml(store, { sessionKey }, "status")).toMatchObject({
      html: "canonical",
    });
  });

  it("requires reapproval for grants stored before byte-frozen semantics", async () => {
    const { sessionKey, database, put, grant, snapshot, document } = boardFixture(
      tempDirs.make("board-legacy-grant-"),
    );
    const current = await put({
      name: "status",
      content: { kind: "html", html: "approved" },
      declared: { tools: ["health"] },
    });
    await grant("status", 1, current.widgets[0]?.instanceId);

    database.db
      .prepare("UPDATE board_widgets SET manifest = ? WHERE session_key = ? AND name = 'status'")
      .run(JSON.stringify({ tools: ["health"] }), sessionKey);

    expect((await snapshot()).widgets[0]).toMatchObject({
      grantState: "pending",
      declared: { tools: ["health"] },
    });
    expect(await document("status")).toMatchObject({
      grantState: "pending",
      declared: { tools: ["health"] },
    });
    expect((await grant("status", 1, current.widgets[0]?.instanceId)).widgets[0]).toMatchObject({
      grantState: "granted",
    });
    const row = database.db
      .prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = 'status'")
      .get(sessionKey) as { manifest: string };
    expect(JSON.parse(row.manifest)).toEqual({
      contentOwner: "html",
      tools: ["health"],
      grantSemanticsVersion: 2,
    });
  });
});
