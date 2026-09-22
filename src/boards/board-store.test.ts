import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardWidgetMaterializedPutParams } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { BoardValidationError } from "./board-layout.js";
import { createBoardWidgetPutSnapshot, type BoardStore } from "./board-store.js";
import { readBoardHtml, createTestBoardStore } from "./board-store.test-support.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

  it("creates the implicit main tab and bumps board and widget revisions", async () => {
    const store = createTestBoardStore();
    const first = await putHtml(store, "agent:main:main", "status");
    const second = await putHtml(store, "agent:main:main", "status", "<p>two</p>");
    expect(first).toMatchObject({
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0 }],
      widgets: [{ name: "status", revision: 1 }],
    });
    expect(second.revision).toBe(2);
    expect(second.widgets[0]!.revision).toBe(2);
  });

  it.each(widgetContents)(
    "preserves $kind widget ownership across same-name updates",
    async (content) => {
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
    },
  );

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

  it("stores HTML bytes with digest and keeps MCP descriptors non-HTML", async () => {
    const store = createTestBoardStore();
    await putHtml(store, "session", "html", "<main>ok</main>");
    await store.putWidget({
      sessionKey: "session",
      name: "app",
      content: {
        kind: "mcp-app",
        descriptor: {
          serverName: "server",
          toolName: "tool",
          uiResourceUri: "ui://resource",
          toolCallId: "call",
        },
        interactive: false,
      },
    });
    expect(await readBoardHtml(store, { sessionKey: "session" }, "html")).toMatchObject({
      html: "<main>ok</main>",
      revision: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await readBoardHtml(store, { sessionKey: "session" }, "app")).toBeUndefined();
    expect(await store.readWidgetMcpApp({ sessionKey: "session" }, "app")).toMatchObject({
      descriptor: {
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
      },
      revision: 1,
      instanceId: expect.stringMatching(/^[a-f0-9]{32}$/u),
      interactive: false,
    });
    expect(await readBoardHtml(store, { sessionKey: "session" }, "unknown")).toBeUndefined();
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

  it("survives reset/new boundaries", async () => {
    const store = createTestBoardStore();
    await putHtml(store, "session", "status");
    // Session reset has no BoardStore call; the stable session key remains authoritative.
    expect((await store.getSnapshot({ sessionKey: "session" })).widgets).toHaveLength(1);
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
    await expect(
      putHtml(createTestBoardStore(), "session", "large", "é".repeat(131_073)),
    ).rejects.toThrow("262144 UTF-8 bytes");
  });

  it("bumps once per applyOps transaction and removes widget bytes", async () => {
    const store = createTestBoardStore();
    await putHtml(store, "session", "status");
    const snapshot = await store.applyOps({ sessionKey: "session" }, [
      { kind: "widget_resize", name: "status", sizeW: 3, sizeH: 3 },
      { kind: "widget_remove", name: "status" },
    ]);
    expect(snapshot.revision).toBe(2);
    expect(snapshot.widgets).toEqual([]);
    expect(await readBoardHtml(store, { sessionKey: "session" }, "status")).toBeUndefined();
  });

  it("preserves position on content updates and honors explicit after placement", async () => {
    const store = createTestBoardStore();
    await putHtml(store, "session", "first");
    await putHtml(store, "session", "second");
    await putHtml(store, "session", "third");

    expect(
      (await putHtml(store, "session", "first", "<p>updated</p>")).widgets.map(
        (widget) => widget.name,
      ),
    ).toEqual(["first", "second", "third"]);
    expect(
      (
        await store.putWidget({
          sessionKey: "session",
          name: "first",
          content: { kind: "html", html: "<p>moved</p>" },
          placement: { after: "third" },
        })
      ).widgets.map((widget) => widget.name),
    ).toEqual(["second", "third", "first"]);
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

  const prepared = await store.getSnapshotWithHtmlViewMetadata({ sessionKey });

  const widgetSelects = prepare.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => /select .* from "board_widgets"/iu.test(sql));
  expect(widgetSelects).toHaveLength(1);
  expect(widgetSelects[0]).toContain('"sha256"');
  expect(widgetSelects[0]).not.toContain('"html"');
  expect(prepared.htmlViewMetadata.get("status")).not.toHaveProperty("html");
  prepare.mockRestore();
});
