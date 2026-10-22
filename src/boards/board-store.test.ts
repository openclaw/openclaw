import { constants, copyFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  boardClient,
  closeBoardDatabases as closeDatabases,
  htmlWidget,
  mcpContent,
  testBoard,
} from "./board-store.fixtures.test-support.js";
import type { BoardStore } from "./board-store.js";
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
const health = { tools: ["health"] };
const instancePattern = /^[a-f0-9]{32}$/u;
const pluginContent = (props?: Record<string, unknown>) => ({
  kind: "plugin" as const,
  pluginKind: "workboard:card",
  ...(props === undefined ? {} : { props }),
});
const registeredContent = (source: string) => ({
  kind: "registered" as const,
  contentKind: "diagram",
  pluginKind: "diagram:diagram",
  source,
});
async function expectWidget(snapshot: Promise<BoardSnapshot>, expected: Record<string, unknown>) {
  expect((await snapshot).widgets[0]).toMatchObject(expected);
}

function fixture() {
  const context = boardFixture(tempDirs.make("board-store-"));
  let store = context.store;
  return {
    ...context,
    html: (name: string, html: string) => putHtml(context.store, context.sessionKey, name, html),
    updateWidget: (set: string, values: SQLInputValue[] = [], name = "status") => {
      context.database.db
        .prepare(`UPDATE board_widgets SET ${set} WHERE session_key = ? AND name = ?`)
        .run(...values, context.sessionKey, name);
    },
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
    ) => {
      return store.putWidget({
        ...htmlWidget(context.sessionKey, name, html),
        title,
        ...(key
          ? {
              generatedIdentity: {
                source: "show_widget" as const,
                key: key.repeat(64),
                fallbackName,
              },
            }
          : {}),
      });
    },
    readHtml: (name: string) => readBoardHtml(store, context.target, name),
    current: () => store.getSnapshot(context.target),
    reopen: async () => {
      await closeDatabases();
      store = new SqliteBoardStore(context.storeOptions);
    },
    unmark: (name: string) => {
      context.database.db
        .prepare(
          "UPDATE board_widgets SET manifest = json_remove(manifest, '$.nameIdentity') WHERE session_key = ? AND name = ?",
        )
        .run(context.sessionKey, name);
    },
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
  expect(created.widgets[0]?.instanceId).toMatch(instancePattern);

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

it("upgrades registered ownership from its exact legacy descriptor and preserves it", async () => {
  const { put, snapshot, grant, updateWidget, manifest } = fixture();
  const content = registeredContent("diagram:first");
  await put({ name: "status", content, declared: { tools: ["health"] } });
  updateWidget("manifest = json_set(manifest, '$.registeredContentKind', 'other')");
  await expect(snapshot()).rejects.toThrow(/content ownership/i);
  updateWidget(
    "manifest = json_remove(manifest, '$.contentOwner', '$.registeredContentKind', '$.registeredInstanceId')",
  );

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
  expect(manifest()).toMatchObject({
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

it("requires current revisions and pending grants", async () => {
  const { put, grant } = testBoard("session");
  const pending = await put({
    name: "networked",
    content: { kind: "html", html: "ok" },
    declared: { tools: ["weather.refresh"] },
  });
  expect(pending.widgets[0]!.grantState).toBe("pending");
  const failure: unknown = await grant("networked", 2).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(BoardValidationError);
  expect(failure).toMatchObject({
    code: "conflict",
    message: expect.stringContaining("revision changed"),
  });
  const granted = await grant("networked", 1, pending.widgets[0]?.instanceId);
  expect(granted.widgets[0]).toMatchObject({ grantState: "granted", revision: 1 });
  await expect(grant("networked", 1, pending.widgets[0]?.instanceId, "rejected")).rejects.toThrow(
    "not pending",
  );
});
it("does not select the HTML BLOB when preparing board view metadata", async () => {
  const { store, database, sessionKey, html } = fixture();
  await html("status", "x".repeat(256 * 1024));
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
  it("preserves native identity and layout through edits, reopen, and replacement", async () => {
    const stateDir = tempDirs.make("board-native-identity-");
    const {
      store,
      put,
      ops,
      snapshot: readSnapshot,
    } = boardClient(createTestBoardStore({ stateDir }), boardSession);
    const putCard = (
      name: string,
      props?: Record<string, unknown>,
      placement?: BoardWidgetMaterializedPutParams["placement"],
    ) => put({ name, content: pluginContent(props), ...(placement ? { placement } : {}) });
    const props = {
      cardId: "card-123",
      compact: true,
      instanceId: "caller-selected",
      pluginInstanceId: "caller-selected",
    };
    const initial = await putCard("work-item", { ...props });
    for (const name of ["left", "right"]) {
      await putCard(name, { side: name });
    }

    expect(initial.widgets[0]).toMatchObject({
      name: "work-item",
      contentKind: "plugin",
      pluginKind: "workboard:card",
      props,
      grantState: "none",
    });
    const instanceId = initial.widgets[0]?.instanceId;
    expect(instanceId).toMatch(instancePattern);
    expect(await readBoardHtml(store, boardSession, "work-item")).toBeUndefined();
    expect(await store.readWidgetMcpApp(boardSession, "work-item")).toBeUndefined();

    const moved = await ops({ kind: "widget_move", name: "work-item", after: "right" });
    expect(moved.widgets.map((widget) => widget.name)).toEqual(["left", "right", "work-item"]);
    expect(moved.widgets[2]?.props).toEqual(props);
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
      expect(await readSnapshot()).toEqual(snapshot);
    }
    const edited = await put({
      name: "work-item",
      title: "Updated status",
      content: pluginContent({ ...props }),
    });
    expect(edited.widgets[1]).toMatchObject({ title: "Updated status", instanceId });
    const resized = await ops({ kind: "widget_resize", name: "work-item", sizeW: 8, sizeH: 6 });
    await closeDatabases();
    const reopened = boardClient(createTestBoardStore({ stateDir }), boardSession);
    expect(await reopened.snapshot()).toEqual(resized);
    expect((await reopened.snapshot()).widgets[1]).toMatchObject({
      title: "Updated status",
      instanceId,
      sizeW: 8,
      sizeH: 6,
    });
    expect(
      (await reopened.store.getSnapshotWithHtmlViewMetadata(boardSession)).htmlViewMetadata.size,
    ).toBe(0);
    await reopened.ops({ kind: "widget_remove", name: "work-item" });
    const replacement = await reopened.put({ name: "work-item", content: pluginContent() });
    expect(replacement.widgets[2]?.instanceId).toMatch(instancePattern);
    expect(replacement.widgets[2]?.instanceId).not.toBe(instanceId);
    expect((await reopened.snapshot()).widgets).toEqual(replacement.widgets);
  });

  it("rejects oversized plugin props and capability declarations", async () => {
    const { put } = testBoard();
    await expect(
      put({
        name: "too-large",
        content: {
          ...pluginContent({ value: "x".repeat(8 * 1024) }),
          pluginKind: "workboard:mini",
        },
      }),
    ).rejects.toThrow("props exceed 8192 UTF-8 bytes");
    await expect(
      put({
        name: "declared",
        content: pluginContent(),
        declared: { tools: ["workboard.cards.move"] },
      }),
    ).rejects.toThrow("do not accept sandbox capability declarations");
  });
});

describe("SqliteBoardStore behavior", () => {
  it("keeps content-kind semantics and normalized ordering", async () => {
    const { store, put, ops, snapshot, app } = testBoard();
    await ops(
      { kind: "tab_create", tabId: "main", title: "Main" },
      { kind: "tab_create", tabId: "notes", title: "Notes" },
    );
    await putHtml(store, boardSession.sessionKey, "first", "first");
    await put({
      name: "app",
      content: mcpContent({ uiResourceUri: "ui://resource" }),
      placement: { tabId: "notes" },
    });
    expect((await snapshot()).widgets).toEqual([
      expect.objectContaining({ name: "first", tabId: "main", position: 0 }),
      expect.objectContaining({ name: "app", tabId: "notes", position: 0 }),
    ]);
    expect(await readBoardHtml(store, boardSession, "app")).toBeUndefined();
    expect(await app()).toMatchObject({
      descriptor: {
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
      },
      revision: 1,
      instanceId: expect.stringMatching(instancePattern),
      interactive: true,
    });
    expect((await snapshot()).widgets[1]?.instanceId).toMatch(instancePattern);
  });

  it.each(["html", "registered"] as const)(
    "preserves %s grants only for unchanged bytes with equal or narrower declarations",
    async (kind) => {
      const documentContent = (text: string) =>
        kind === "html" ? { kind, html: text } : registeredContent(text);
      const { put: putWidget, grant, document } = testBoard();
      const wide = {
        netOrigins: ["https://one.example", "https://two.example"],
        tools: ["weather.read", "weather.refresh"],
      };
      const narrow = { netOrigins: ["https://one.example"], tools: ["weather.read"] };
      const put = (text: string, declared = narrow) =>
        putWidget({ name: "scoped", content: documentContent(text), declared });
      const first = await put("one", wide);
      await grant("scoped", 1, first.widgets[0]?.instanceId);

      await expectWidget(put("one", wide), { revision: 2, grantState: "granted" });
      expect(await document("scoped")).toMatchObject({
        [kind === "html" ? "html" : "source"]: "one",
        grantState: "granted",
      });

      await expectWidget(put("one"), { revision: 3, grantState: "granted" });

      const changed = await put("two");
      expect(changed.widgets[0]).toMatchObject({ revision: 4, grantState: "pending" });
      expect(await document("scoped")).toMatchObject({
        [kind === "html" ? "html" : "source"]: "two",
        grantState: "pending",
      });
      await grant("scoped", 4, changed.widgets[0]?.instanceId);

      await expectWidget(
        put("two", { ...narrow, netOrigins: ["https://one.example", "https://three.example"] }),
        { revision: 5, grantState: "pending" },
      );
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
    await expectWidget(put("server-b", "call-c"), { revision: 3, grantState: "granted" });
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
    await expectWidget(grant("app", 1, replacement.widgets[0]?.instanceId), {
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
        ...htmlWidget(sessionKey, "broken", "broken"),
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

    expect(await readBoardHtml(store, { sessionKey }, "status")).toMatchObject({
      html: "canonical",
    });
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
    });
    expect(manifest()).toEqual({
      contentOwner: "html",
      tools: ["health"],
      grantSemanticsVersion: 2,
    });
  });
});

it("keeps colliding titles distinct and canonical spellings stable", async () => {
  const { pin, readHtml: html } = fixture();
  expect((await pin("cafe-menu", "Café Menu", "accented", "a")).resolvedWidgetName).toBe(
    "cafe-menu",
  );
  expect(await pin("cafe-menu", "Cafe\u0301 Menu", "revised", "a")).toMatchObject({
    resolvedWidgetName: "cafe-menu",
    widgets: [{ name: "cafe-menu", revision: 2 }],
  });
  const plain = await pin("cafe-menu", "Cafe Menu", "plain", "b");
  expect(plain.resolvedWidgetName).toBe("cafe-menu-bbbbbbbb");
  expect(plain.widgets.map(({ name }) => name)).toEqual(["cafe-menu", "cafe-menu-bbbbbbbb"]);
  expect((await html("cafe-menu"))?.html).toContain("revised");
  expect(await pin("cafe-menu", "Cafe Menu", "plain revised", "b")).toMatchObject({
    resolvedWidgetName: "cafe-menu-bbbbbbbb",
    widgets: [
      { name: "cafe-menu", revision: 2 },
      { name: "cafe-menu-bbbbbbbb", revision: 2 },
    ],
  });
});

it.each([false, true])(
  "persists explicit ownership after generated takeover: %s",
  async (takeover) => {
    const { pin, readHtml: html, reopen } = fixture();
    if (takeover) {
      await pin("status", "Status", "generated", "c");
    }
    await pin("status", "Status", "manual");
    if (takeover) {
      expect((await pin("status", "Status", "generated", "c")).resolvedWidgetName).toBe(
        "status-cccccccc",
      );
      expect((await html("status"))?.html).toContain("manual");
    }
    await reopen();
    expect(await pin("status", "Status", "generated", "c")).toMatchObject({
      resolvedWidgetName: "status-cccccccc",
      widgets: [{ name: "status" }, { name: "status-cccccccc" }],
    });
    expect((await html("status"))?.html).toContain("manual");
  },
);

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
  const {
    put,
    pin,
    readHtml: html,
    reopen,
    unmark,
    current: snapshot,
    grant,
    ops,
    manifest,
  } = fixture();
  await pin("anchor", "Anchor", "anchor");
  const legacy = await put({
    name: "cafe-menu",
    title: "Café Menu",
    content: { kind: "html", html: "approved" },
    declared: { tools: ["menu.refresh"] },
  });
  await grant("cafe-menu", 1, legacy.widgets.find(({ name }) => name === "cafe-menu")?.instanceId);
  await ops({ kind: "widget_resize", name: "cafe-menu", sizeW: 8, sizeH: 6 });
  unmark("cafe-menu");
  await reopen();
  const generated = await pin("cafe-menu", "Cafe\u0301 Menu", "generated", "e");
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
  expect((await html("cafe-menu"))?.html).toContain("approved");
  await reopen();
  const reused = await pin("cafe-menu", "Café Menu", "generated revised", "e");
  expect(reused.resolvedWidgetName).toBe("cafe-menu-eeeeeeee");
  expect(reused.widgets.find(({ name }) => name === "cafe-menu-eeeeeeee")).toMatchObject({
    revision: 2,
  });
  expect((await html("cafe-menu"))?.html).toContain("approved");
  await reopen();
  expect((await snapshot()).widgets.find(({ name }) => name === "cafe-menu")).toMatchObject(
    preserved,
  );
  expect(manifest("cafe-menu-eeeeeeee")).toMatchObject({
    nameIdentity: { kind: "generated", source: "show_widget", key: "e".repeat(64) },
  });
});

it("does not infer generated ownership from a canonical unmarked title match", async () => {
  const { pin, readHtml: html, reopen, unmark } = fixture();
  await pin("widget-e3b21956", "が", "legacy");
  unmark("widget-e3b21956");
  await reopen();
  expect(await pin("widget-f62b28f7", "が", "updated", "a", "widget-aaaaaaaa")).toMatchObject({
    resolvedWidgetName: "widget-f62b28f7",
    widgets: [{ name: "widget-e3b21956" }, { name: "widget-f62b28f7" }],
  });
  expect((await html("widget-e3b21956"))?.html).toContain("legacy");
});
