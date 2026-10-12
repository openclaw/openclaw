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
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { restoreEmptyV21StorageForHistoricalFixture } from "../state/openclaw-agent-schema-v21.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { BoardValidationError } from "./board-layout.js";
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

async function closeDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

function seedSession(env: NodeJS.ProcessEnv, agentId: string, sessionKey: string): string {
  const database = openOpenClawAgentDatabase({ agentId, env });
  const sessionId = `session-${agentId}-${sessionKey.replaceAll(":", "-")}`;
  replaceSessionEntrySync(
    { agentId, env, sessionKey, storePath: database.path },
    { sessionId, updatedAt: Date.now() },
  );
  return database.path;
}

async function putHtml(store: BoardStore, sessionKey: string, name: string, html = "<p>one</p>") {
  return await store.putWidget({ sessionKey, name, content: { kind: "html", html } });
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
  {
    kind: "mcp-app",
    descriptor: {
      serverName: "server",
      toolName: "tool",
      uiResourceUri: "ui://resource",
      toolCallId: "call",
    },
    interactive: false,
  },
] satisfies BoardWidgetMaterializedPutParams["content"][];

describe("board store", () => {
  it("releases SQLite before awaiting a widget consumer's external work", async () => {
    const stateDir = tempDirs.make("openclaw-board-consume-");
    const store = createTestBoardStore({ stateDir });
    const target = { sessionKey: "agent:main:consume" };
    await putHtml(store, target.sessionKey, "status", "original");
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
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
    expect(await readBoardHtml(store, target, "status")).toMatchObject({
      html: "replacement",
    });
  });

  it.each(
    widgetContents.filter((content) => content.kind === "plugin" || content.kind === "registered"),
  )("preserves $kind widget ownership across same-name updates", async (content) => {
    const store = createTestBoardStore();
    const name = `${content.kind}-status`;
    const created = await store.putWidget({ sessionKey: "session", name, content });
    expect(created.widgets[0]?.instanceId).toMatch(/^[a-f0-9]{32}$/u);

    expect(created.widgets[0]).toMatchObject({
      contentOwner: content.kind,
      ...(content.kind === "registered" ? { registeredContentKind: content.contentKind } : {}),
    });

    for (const replacement of widgetContents.filter(
      (candidate) => candidate.kind !== content.kind,
    )) {
      await expect(
        store.putWidget({ sessionKey: "session", name, content: replacement }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "invalid_operation",
          message: expect.stringMatching(/same content kind.*remove/i),
        }),
      );
      expect(await store.getSnapshot({ sessionKey: "session" })).toMatchObject({
        revision: created.revision,
        widgets: created.widgets,
      });
    }

    if (content.kind === "plugin" || content.kind === "registered") {
      await expect(
        store.putWidget({
          sessionKey: "session",
          name,
          content: { ...content, pluginKind: "other:replacement" },
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "invalid_operation" }));
      expect(await store.getSnapshot({ sessionKey: "session" })).toMatchObject({
        revision: created.revision,
        widgets: created.widgets,
      });
    }

    if (content.kind === "registered") {
      await expect(
        store.putWidget({
          sessionKey: "session",
          name,
          content: { ...content, contentKind: "alternate" },
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "invalid_operation" }));
      expect(await store.getSnapshot({ sessionKey: "session" })).toMatchObject({
        revision: created.revision,
        widgets: created.widgets,
      });
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

    const updated = (await store.putWidget({ sessionKey: "session", name, content })).widgets[0]!;
    expect(updated).toMatchObject({
      name,
      revision: 2,
    });
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
    expect(
      (await store.putWidget({ sessionKey: "session", name, content: replacement })).widgets[0],
    ).toMatchObject({
      contentKind: replacement.kind === "registered" ? "plugin" : replacement.kind,
      contentOwner: replacement.kind,
      revision: 1,
    });
  });

  it("upgrades registered ownership from its exact legacy descriptor and preserves it", async () => {
    const stateDir = tempDirs.make("openclaw-board-legacy-registered-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:legacy-registered";
    const store = createTestBoardStore({ stateDir });
    const content = {
      kind: "registered" as const,
      contentKind: "diagram",
      pluginKind: "diagram:diagram",
      source: "diagram:first",
    };
    await store.putWidget({ sessionKey, name: "status", content, declared: { tools: ["health"] } });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare(
        "UPDATE board_widgets SET manifest = json_set(manifest, '$.registeredContentKind', 'other') WHERE session_key = ? AND name = 'status'",
      )
      .run(sessionKey);
    await expect(store.getSnapshot({ sessionKey })).rejects.toThrow(/content ownership/i);
    database.db
      .prepare(
        "UPDATE board_widgets SET manifest = json_remove(manifest, '$.contentOwner', '$.registeredContentKind', '$.registeredInstanceId') WHERE session_key = ? AND name = 'status'",
      )
      .run(sessionKey);

    const legacy = (await store.getSnapshot({ sessionKey })).widgets[0]!;
    expect(legacy).toMatchObject({ contentOwner: "registered", registeredContentKind: "diagram" });
    expect(legacy).not.toHaveProperty("instanceId");
    await expect(
      store.putWidget({
        sessionKey,
        name: "status",
        content: { kind: "plugin", pluginKind: "diagram:diagram" },
      }),
    ).rejects.toThrow(/same content kind.*remove/i);
    await expect(
      store.putWidget({
        sessionKey,
        name: "status",
        content: { ...content, contentKind: "other" },
      }),
    ).rejects.toThrow(/same content kind.*remove/i);

    const refreshed = await store.putWidget({
      sessionKey,
      name: "status",
      content: { ...content, source: "diagram:refreshed" },
      declared: { tools: ["health"] },
    });
    await store.grant({ sessionKey }, "status", "granted", 2, refreshed.widgets[0]?.instanceId);
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
    expect((await store.getSnapshot({ sessionKey: "session-a" })).tabs[0]!.title).toBe("Main");
    expect((await store.getSnapshot({ sessionKey: "session-a" })).widgets).toMatchObject([
      { name: "a" },
    ]);
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
    const store = createTestBoardStore();
    const pending = await store.putWidget({
      sessionKey: "session",
      name: "networked",
      content: { kind: "html", html: "<p>ok</p>" },
      declared: { netOrigins: ["https://example.com"] },
    });
    expect(pending.widgets[0]!.grantState).toBe("pending");
    expect(
      (
        await store.grant(
          { sessionKey: "session" },
          "networked",
          "granted",
          1,
          pending.widgets[0]?.instanceId,
        )
      ).widgets[0]!.grantState,
    ).toBe("granted");
    await expect(
      store.grant(
        { sessionKey: "session" },
        "networked",
        "rejected",
        1,
        pending.widgets[0]?.instanceId,
      ),
    ).rejects.toThrow("not pending");
  });

  it("rejects stale grant revisions and accepts the current revision", async () => {
    const store = createTestBoardStore();
    const pending = await store.putWidget({
      sessionKey: "session",
      name: "networked",
      content: { kind: "html", html: "ok" },
      declared: { tools: ["weather.refresh"] },
    });
    try {
      await store.grant({ sessionKey: "session" }, "networked", "granted", 2);
      throw new Error("expected stale grant to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoardValidationError);
      expect(error).toMatchObject({ code: "conflict" });
      expect((error as Error).message).toContain("revision changed");
    }
    expect(
      (
        await store.grant(
          { sessionKey: "session" },
          "networked",
          "granted",
          1,
          pending.widgets[0]?.instanceId,
        )
      ).widgets[0],
    ).toMatchObject({
      grantState: "granted",
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
  const boardSession = { sessionKey: "agent:main:board" };

  it("replaces omitted plugin props without changing unrelated layout state", async () => {
    const store = createTestBoardStore();
    const initial = await store.putWidget({
      ...boardSession,
      name: "work-item",
      content: {
        kind: "plugin",
        pluginKind: "workboard:card",
        props: { cardId: "card-123", compact: true },
      },
    });
    for (const name of ["left", "right"]) {
      await store.putWidget({
        ...boardSession,
        name,
        content: { kind: "plugin", pluginKind: "workboard:card", props: { side: name } },
      });
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

    const put = await store.putWidget({
      ...boardSession,
      name: "work-item",
      content: { kind: "plugin", pluginKind: "workboard:card" },
    });

    expect(put.widgets.map((widget) => widget.name)).toEqual(["left", "right", "work-item"]);
    expect(put.widgets[0]).toEqual(left);
    expect(put.widgets[1]).toEqual(right);
    expect(put.widgets[2]).not.toHaveProperty("props");
    expect(put.widgets[2]?.instanceId).toBe(instanceId);
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
    expect(placed.widgets[1]?.instanceId).toBe(instanceId);
    expect(placed.widgets[2]).toEqual({ ...right, position: 2 });
    const { resolvedWidgetName: placedName, ...placedSnapshot } = placed;
    expect(placedName).toBe("work-item");
    expect(await store.getSnapshot(boardSession)).toEqual(placedSnapshot);
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
  const boardSession = { sessionKey: "agent:main:board" };

  it("keeps content-kind semantics and normalized ordering", async () => {
    const store = createTestBoardStore();
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

  it.each(["html", "registered"] as const)(
    "preserves %s grants only for unchanged bytes with equal or narrower declarations",
    async (kind) => {
      const documentContent = (text: string) =>
        kind === "html"
          ? { kind, html: text }
          : { kind, contentKind: "diagram", pluginKind: "diagram:diagram", source: text };
      const store = createTestBoardStore();
      const first = await store.putWidget({
        ...boardSession,
        name: "scoped",
        content: documentContent("one"),
        declared: {
          netOrigins: ["https://one.example", "https://two.example"],
          tools: ["weather.read", "weather.refresh"],
        },
      });
      await store.grant(boardSession, "scoped", "granted", 1, first.widgets[0]?.instanceId);

      const equal = await store.putWidget({
        ...boardSession,
        name: "scoped",
        content: documentContent("one"),
        declared: {
          netOrigins: ["https://one.example", "https://two.example"],
          tools: ["weather.read", "weather.refresh"],
        },
      });
      expect(equal.widgets[0]).toMatchObject({ revision: 2, grantState: "granted" });
      expect(
        await store.useWidgetDocument(boardSession, "scoped", (document) => document),
      ).toMatchObject({
        ...(kind === "html" ? { html: "one" } : { source: "one" }),
        grantState: "granted",
      });

      const narrower = await store.putWidget({
        ...boardSession,
        name: "scoped",
        content: documentContent("one"),
        declared: {
          netOrigins: ["https://one.example"],
          tools: ["weather.read"],
        },
      });
      expect(narrower.widgets[0]).toMatchObject({ revision: 3, grantState: "granted" });

      const changed = await store.putWidget({
        ...boardSession,
        name: "scoped",
        content: documentContent("two"),
        declared: {
          netOrigins: ["https://one.example"],
          tools: ["weather.read"],
        },
      });
      expect(changed.widgets[0]).toMatchObject({ revision: 4, grantState: "pending" });
      expect(
        await store.useWidgetDocument(boardSession, "scoped", (document) => document),
      ).toMatchObject({
        ...(kind === "html" ? { html: "two" } : { source: "two" }),
        grantState: "pending",
      });
      await store.grant(boardSession, "scoped", "granted", 4, changed.widgets[0]?.instanceId);

      const wider = await store.putWidget({
        ...boardSession,
        name: "scoped",
        content: documentContent("two"),
        declared: {
          netOrigins: ["https://one.example", "https://three.example"],
          tools: ["weather.read"],
        },
      });
      expect(wider.widgets[0]).toMatchObject({ revision: 5, grantState: "pending" });
    },
  );

  it("requires a fresh grant when an MCP app widget changes servers", async () => {
    const store = createTestBoardStore();
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
    const store = createTestBoardStore();
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
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

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
    const storePath = seedSession(env, "main", sessionKey);
    await deleteSessionEntryLifecycle({
      env,
      storePath,
      archiveTranscript: false,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
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
});
