import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { InMemoryBoardStore, type BoardStore } from "./board-store.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const tempDirs: string[] = [];

function createSqliteStore(): BoardStore {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-board-parity-"));
  tempDirs.push(stateDir);
  return new SqliteBoardStore({
    resolveAgentId: (sessionKey) => sessionKey.split(":")[1] ?? "main",
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe.each([
  ["memory", () => new InMemoryBoardStore()],
  ["sqlite", createSqliteStore],
] as const)("BoardStore parity: %s", (_kind, createStore) => {
  it("persists revisions, layout, bytes, and declared summaries", () => {
    const store = createStore();
    const first = store.putWidget({
      sessionKey: "agent:main:board",
      name: "weather",
      content: { kind: "html", html: "<p>one</p>" },
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
          declaredSummary: [
            "Network access: https://weather.example",
            "Tool access: weather.refresh",
          ],
        },
      ],
    });
    expect(store.readWidgetHtml("agent:main:board", "weather")).toMatchObject({
      html: "<p>one</p>",
      revision: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const resized = store.applyOps("agent:main:board", [
      { kind: "widget_resize", name: "weather", sizeW: 8, sizeH: 6 },
    ]);
    expect(resized).toMatchObject({
      revision: 2,
      widgets: [{ sizeW: 8, sizeH: 6, revision: 1 }],
    });
    expect(store.grant("agent:main:board", "weather", "granted")).toMatchObject({
      revision: 3,
      widgets: [{ grantState: "granted" }],
    });

    const updated = store.putWidget({
      sessionKey: "agent:main:board",
      name: "weather",
      content: { kind: "html", html: "<p>two</p>" },
    });
    expect(updated).toMatchObject({
      revision: 4,
      widgets: [{ revision: 2, grantState: "none", sizeW: 8, sizeH: 6 }],
    });
    expect(updated.widgets[0]).not.toHaveProperty("declaredSummary");
  });

  it("keeps content-kind semantics and normalized ordering", () => {
    const store = createStore();
    store.applyOps("agent:main:board", [
      { kind: "tab_create", tabId: "main", title: "Main" },
      { kind: "tab_create", tabId: "notes", title: "Notes" },
    ]);
    store.putWidget({
      sessionKey: "agent:main:board",
      name: "first",
      content: { kind: "html", html: "first" },
    });
    store.putWidget({
      sessionKey: "agent:main:board",
      name: "app",
      content: {
        kind: "mcp-app",
        descriptor: {
          serverName: "server",
          toolName: "tool",
          uiResourceUri: "ui://resource",
          originSessionKey: "agent:main:origin",
          toolCallId: "call",
        },
      },
      placement: { tabId: "notes" },
    });
    expect(store.getSnapshot("agent:main:board").widgets).toEqual([
      expect.objectContaining({ name: "first", tabId: "main", position: 0 }),
      expect.objectContaining({ name: "app", tabId: "notes", position: 0 }),
    ]);
    expect(store.readWidgetHtml("agent:main:board", "app")).toEqual({
      descriptor: {
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        originSessionKey: "agent:main:origin",
        toolCallId: "call",
      },
      revision: 1,
    });
  });

  it("survives reset boundaries and deletes only on session deletion", () => {
    const store = createStore();
    store.putWidget({
      sessionKey: "agent:main:board",
      name: "status",
      content: { kind: "html", html: "ok" },
    });
    // Reset/new never calls BoardStore; the stable session key keeps its rows.
    expect(store.getSnapshot("agent:main:board").widgets).toHaveLength(1);
    expect(store.listSessionsWithBoards()).toEqual(["agent:main:board"]);
    store.deleteSession("agent:main:board", "main");
    expect(store.getSnapshot("agent:main:board")).toEqual({
      sessionKey: "agent:main:board",
      revision: 0,
      tabs: [],
      widgets: [],
    });
    expect(store.listSessionsWithBoards()).toEqual([]);
  });

  it("drops an empty board after its last tab is deleted", () => {
    const store = createStore();
    store.applyOps("agent:main:board", [{ kind: "tab_create", tabId: "main", title: "Main" }]);
    expect(
      store.applyOps("agent:main:board", [{ kind: "tab_delete", tabId: "main" }]),
    ).toMatchObject({ revision: 2, tabs: [], widgets: [] });
    expect(store.getSnapshot("agent:main:board").revision).toBe(0);
    expect(store.listSessionsWithBoards()).toEqual([]);
  });
});

describe("SqliteBoardStore persistence", () => {
  it("reopens durable boards and isolates owning agent databases", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-board-durable-"));
    tempDirs.push(stateDir);
    const options = {
      resolveAgentId: (sessionKey: string) => sessionKey.split(":")[1] ?? "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    const store = new SqliteBoardStore(options);
    store.putWidget({
      sessionKey: "agent:alpha:board",
      name: "alpha",
      content: { kind: "html", html: "alpha" },
    });
    store.putWidget({
      sessionKey: "agent:beta:board",
      name: "beta",
      content: { kind: "html", html: "beta" },
    });

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const reopened = new SqliteBoardStore(options);
    expect(reopened.getSnapshot("agent:alpha:board").widgets).toEqual([
      expect.objectContaining({ name: "alpha", revision: 1 }),
    ]);
    expect(reopened.getSnapshot("agent:beta:board").widgets).toEqual([
      expect.objectContaining({ name: "beta", revision: 1 }),
    ]);
    expect(reopened.listSessionsWithBoards()).toEqual(["agent:alpha:board", "agent:beta:board"]);
  });
});
