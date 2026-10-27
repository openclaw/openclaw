// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { cacheChatBoardSnapshotAfterHydration } from "./chat-board-snapshot.ts";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  clearChatMessagesFromCache,
  createChatWidgetLayout,
  observeChatCache,
  readChatMessagesFromCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";

function createCacheContext(
  assistantAgentId = "ops",
  agentsList = { defaultId: "ops", mainKey: "home" },
) {
  const host = { assistantAgentId, agentsList };
  const cache: ChatMessageCache = new Map();
  const target = (sessionKey = "home", agentId?: string) => ({ sessionKey, agentId });
  const read = (sessionKey = "home") => readChatSessionSnapshot(cache, host, target(sessionKey));
  const write = (snapshot: ChatSessionSnapshot, sessionKey = "home") =>
    cacheChatSessionSnapshot(cache, host, target(sessionKey), snapshot);
  return {
    read,
    write,
    messages: (sessionKey: string, agentId?: string) =>
      readChatMessagesFromCache(cache, host, target(sessionKey, agentId)),
    writeMessages: (sessionKey: string, messages: unknown[], agentId?: string) =>
      cacheChatSessionSnapshot(
        cache,
        host,
        target(sessionKey, agentId),
        widgetSnapshot(messages, null),
      ),
    append: (sessionKey: string, message: unknown, event?: object) =>
      appendChatMessageToCache(cache, host, target(sessionKey), message, event),
    clear: (sessionKey = "home") => clearChatMessagesFromCache(cache, host, target(sessionKey)),
    layout: () => createChatWidgetLayout()(cache, host, target()),
  };
}

const widgetSnapshot = (
  messages: unknown[] = ["widget"],
  sessionId: string | null = "session-1",
  extras: Partial<ChatSessionSnapshot> = {},
): ChatSessionSnapshot => ({ messages, pagination: { hasMore: false }, sessionId, ...extras });

describe("session message cache", () => {
  it("retains reaction facts only across the same session incarnation", () => {
    const { read, write } = createCacheContext();
    const summaries = [{ emoji: "👍", count: 1, identities: [{ id: "peer" }] }];
    write(widgetSnapshot(["first"], "session-1", { messageReactions: { reply: summaries } }));
    write(widgetSnapshot(["new history"], "session-1"));
    expect(read()?.messageReactions).toEqual({ reply: summaries });
    write(widgetSnapshot(["replacement"], "session-2"));
    expect(read()?.messageReactions).toBeUndefined();
  });

  it("retains composer display facts only for the same session incarnation", () => {
    const { read, write } = createCacheContext();
    const composer = {
      id: "saved",
      provider: "example",
      name: "Saved",
      permissionMode: "full" as const,
    };
    write(widgetSnapshot(["cached"], "session-1", { composer }));
    write(widgetSnapshot(["live"], "session-1"));
    expect(read()?.composer).toEqual(composer);
    write(widgetSnapshot(["reset"], "session-2"));
    expect(read()?.composer).toBeUndefined();
  });

  it("retains header viewers through history catch-up without crossing session or account scope", () => {
    const cache: ChatMessageCache = new Map();
    const host = {
      settings: { gatewayUrl: "wss://gateway.example" },
      client: { recoveryScope: "account-a", recoveryScopeReady: true },
    };
    const target = { sessionKey: "agent:main:viewers" };
    const headerViewers = {
      users: [{ id: "peer", name: "Peer" }],
      totalCount: 5,
      ownerViewing: false,
    };
    cacheChatSessionSnapshot(
      cache,
      host,
      target,
      widgetSnapshot([], "one", { headerViewers, headerSharing: "public" }),
    );
    cacheChatSessionSnapshot(cache, host, target, widgetSnapshot(["live"], "one"));
    expect(readChatSessionSnapshot(cache, host, target)?.headerViewers).toEqual(headerViewers);
    expect(readChatSessionSnapshot(cache, host, target)?.headerSharing).toBe("public");
    host.client.recoveryScope = "account-b";
    expect(readChatSessionSnapshot(cache, host, target)).toBeNull();
    host.client.recoveryScope = "account-a";
    cacheChatSessionSnapshot(cache, host, target, widgetSnapshot(["replacement"], "two"));
    expect(readChatSessionSnapshot(cache, host, target)?.headerViewers).toBeUndefined();
    expect(readChatSessionSnapshot(cache, host, target)?.headerSharing).toBeUndefined();
  });

  it("publishes a footprint batch once and rejects a retired session's deferred batch", () => {
    const cache: ChatMessageCache = new Map();
    const host = { assistantAgentId: "main" };
    const target = { sessionKey: "agent:main:batch" };
    cacheChatSessionSnapshot(cache, host, target, widgetSnapshot([], "one"));
    const layout = createChatWidgetLayout()(cache, host, target);
    expect(layout.readRows()).toBeUndefined();
    const write = vi.fn();
    observeChatCache(cache, { write, delete: vi.fn() });
    const heights = {
      'row:v1:768:appearance:first:"one"': 100,
      'row:v1:768:appearance:second:"two"': 200,
    };
    layout.writeRows(heights);
    expect(write).toHaveBeenCalledTimes(1);
    expect(readChatSessionSnapshot(cache, host, target)?.widgetHeights).toEqual(heights);
    // Newly measured rows belong to the next reload, not this admission.
    expect(layout.readRows()).toBeUndefined();
    const reloaded = createChatWidgetLayout()(cache, host, target);
    expect(reloaded.readRows()).toEqual(heights);
    layout.writeRows(heights);
    expect(write).toHaveBeenCalledTimes(1);
    cacheChatSessionSnapshot(cache, host, target, widgetSnapshot([], "two"));
    write.mockClear();
    layout.writeRows(heights);
    expect(write).not.toHaveBeenCalled();
    expect(readChatSessionSnapshot(cache, host, target)?.widgetHeights).toBeUndefined();
    expect(reloaded.readRows()).toBeUndefined();
  });
  it("retires admitted row heights when the same session key moves to another account", () => {
    const cache: ChatMessageCache = new Map();
    const host = {
      assistantAgentId: "main",
      settings: { gatewayUrl: "wss://cache.example" },
      client: { recoveryScope: "account-a", recoveryScopeReady: true },
    };
    const target = { sessionKey: "agent:main:batch" };
    const row = 'row:v1:768:appearance:first:"one"';
    cacheChatSessionSnapshot(
      cache,
      host,
      target,
      widgetSnapshot([], "one", { widgetHeights: { [row]: 100 } }),
    );
    const layout = createChatWidgetLayout()(cache, host, target);
    expect(layout.readRows()).toEqual({ [row]: 100 });
    host.client.recoveryScope = "account-b";
    cacheChatSessionSnapshot(
      cache,
      host,
      target,
      widgetSnapshot([], "one", { widgetHeights: { [row]: 200 } }),
    );
    expect(layout.readRows()).toBeUndefined();
    expect(layout.read(row)).toBeUndefined();
    expect(createChatWidgetLayout()(cache, host, target).readRows()).toEqual({ [row]: 200 });
  });
  it("keeps the settled row reservation through an initial short widget report", () => {
    const context = createCacheContext();
    const row = 'row:v1:768:gutter:revision-1:"widget-row"';
    context.write(
      widgetSnapshot([], "session-1", {
        widgetHeights: { [row]: 700, "canvas:widget": 600 },
      }),
    );
    const layout = context.layout();
    // The existing bridge can report its body before load and late widget content.
    layout.write("canvas:widget", 200, "widget-row");
    layout.write(row, 300);
    expect(layout.read(row)).toBe(700);
    expect(context.layout().read(row)).toBe(700);
  });
  it("retains a matching settled footprint for the following reload without another resize", () => {
    const context = createCacheContext();
    const row = 'row:v1:768:gutter:revision-1:"widget-row"';
    context.write(
      widgetSnapshot([], "session-1", { widgetHeights: { [row]: 700, "canvas:widget": 600 } }),
    );
    const layout = context.layout();
    expect(layout.write("canvas:widget", 600, "widget-row", true)).toBe(600);
    expect(layout.read(row)).toBeUndefined();
    expect(context.layout().read(row)).toBe(700);
  });
  it("reserves an unchanged row while keeping widths, revisions and widget resizes independent", () => {
    const context = createCacheContext();
    const row = 'row:v1:768:gutter:revision-1:"notice"';
    context.write(widgetSnapshot([], "session-1", { widgetHeights: { [row]: 300 } }));
    const layout = context.layout();
    layout.write(row, 100);
    layout.write('row:v1:400:gutter:revision-1:"notice"', 200);
    layout.write('row:v1:768:gutter:revision-2:"notice"', 39);
    layout.write("canvas:widget", 300);
    layout.write("canvas:widget", 100);
    const restored = context.layout();
    expect([
      restored.read(row),
      restored.read('row:v1:400:gutter:revision-1:"notice"'),
      restored.read('row:v1:768:gutter:revision-2:"notice"'),
      restored.read("canvas:widget"),
    ]).toEqual([300, 200, 39, 100]);
  });
  it("retires only the containing row's footprints when its widget shrinks or a disclosure changes", () => {
    const context = createCacheContext();
    const row = 'row:v1:768:gutter:revision-1:"widget-row"';
    const narrow = 'row:v1:400:gutter:revision-1:"widget-row"';
    const neighbor = 'row:v1:768:gutter:revision-1:"neighbor"';
    context.write(
      widgetSnapshot([], "session-1", {
        widgetHeights: { [row]: 700, [narrow]: 700, [neighbor]: 700 },
      }),
    );
    const layout = context.layout();
    layout.write("canvas:widget", 600);
    layout.write("canvas:widget", 200, "widget-row", true);
    expect([layout.read(row), layout.read(narrow), layout.read(neighbor)]).toEqual([
      undefined,
      undefined,
      700,
    ]);
    layout.write(row, 300);
    layout.write(row, 200);
    expect(context.layout().read(row)).toBe(200);
    layout.invalidateRow("neighbor");
    expect(layout.read(neighbor)).toBeUndefined();
  });
  it("retains an admitted sibling's frame through eviction and uses its settled size on remount", () => {
    const context = createCacheContext();
    const row = 'row:v1:768:gutter:revision-1:"widget-row"';
    context.write(
      widgetSnapshot([], "session-1", {
        widgetHeights: { [row]: 1000, "canvas:first": 200, "canvas:pending": 600 },
      }),
    );
    const layout = context.layout();
    expect(layout.read(row)).toBe(1000);
    for (let i = 0; i < 100; i++) {
      layout.write(`canvas:other-${i}`, 48);
    }
    expect(layout.read("canvas:pending")).toBe(600);
    layout.write("canvas:first", 100, "widget-row", true);
    expect(layout.read(row)).toBeUndefined();
    expect(layout.write("canvas:pending", 200, "widget-row")).toBe(600);
    layout.write("canvas:pending", 200, "widget-row", true);
    expect(layout.write("canvas:pending", 100, "widget-row")).toBe(200);
  });
  it.each([false, true])(
    "retires a settled row even when its frame entry was evicted (early=%s)",
    (early) => {
      const context = createCacheContext();
      const row = 'row:v1:768:gutter:revision-1:"widget-row"';
      context.write(widgetSnapshot([], "session-1", { widgetHeights: { [row]: 700 } }));
      const layout = context.layout();
      if (early) {
        layout.write("canvas:widget", 200, "widget-row");
      }
      expect(layout.read(row)).toBe(700);
      layout.write("canvas:widget", 200, "widget-row", true);
      expect(layout.read(row)).toBeUndefined();
      layout.write(row, 300);
      expect(context.layout().read(row)).toBe(300);
    },
  );
  it("releases a failed widget's reservation and frame height without retiring a neighboring row", () => {
    const context = createCacheContext();
    const row = 'row:v1:768:gutter:revision-1:"widget-row"';
    const neighbor = 'row:v1:768:gutter:revision-1:"neighbor"';
    context.write(
      widgetSnapshot([], "session-1", {
        widgetHeights: { [row]: 700, [neighbor]: 300, "canvas:widget": 600 },
      }),
    );
    const layout = context.layout();
    layout.write("canvas:widget", null, "widget-row", true);
    expect([layout.read(row), layout.read("canvas:widget"), layout.read(neighbor)]).toEqual([
      undefined,
      undefined,
      300,
    ]);
    layout.write(row, 80);
    expect(context.layout().read(row)).toBe(80);
  });
  it("retains a scoped board through transcript replacement and clears it authoritatively", () => {
    const cache: ChatMessageCache = new Map();
    const host = {
      chatMessagesBySession: cache,
      assistantAgentId: "ops",
      settings: { gatewayUrl: "wss://cache.example" },
      client: { recoveryScope: "account-a" },
    };
    const target = { sessionKey: "dashboard" };
    const board = { sessionKey: "agent:ops:dashboard", revision: 1, tabs: [], widgets: [] };
    cacheChatBoardSnapshotAfterHydration(host, target, board, 100, () => true);
    expect(readChatSessionSnapshot(cache, host, target)?.board).toEqual({
      snapshot: board,
      receivedAtMs: 100,
    });
    cacheChatSessionSnapshot(cache, host, target, widgetSnapshot(["new transcript"], "session-2"));
    expect(readChatSessionSnapshot(cache, host, target)?.board?.snapshot).toEqual(board);
    const foreign = { ...host, client: { recoveryScope: "account-b" } };
    expect(readChatSessionSnapshot(cache, foreign, target)).toBeNull();
    cacheChatBoardSnapshotAfterHydration(host, target, null, 100, () => true);
    expect(readChatSessionSnapshot(cache, host, target)?.board).toBeNull();
    cacheChatSessionSnapshot(cache, host, target, widgetSnapshot(["refreshed"], "session-2"));
    expect(readChatSessionSnapshot(cache, host, target)?.board).toBeNull();
  });

  it.each([
    {
      name: "Matrix room and thread IDs",
      sessionKey: "Agent:Ops:Matrix:Channel:!Room:Example.Org:Thread:$Event",
      canonicalKey: "agent:ops:matrix:channel:!Room:Example.Org:thread:$Event",
      distinctKey: "agent:ops:matrix:channel:!Room:Example.Org:thread:$event",
    },
    {
      name: "Signal group IDs with a normalized thread suffix",
      sessionKey: "Agent:Ops:Signal:Group:AbC123=:Thread:XyZ",
      canonicalKey: "agent:ops:signal:group:AbC123=:thread:xyz",
      distinctKey: "agent:ops:signal:group:abc123=:thread:xyz",
    },
  ])(
    "keeps case-distinct $name in separate transcript caches",
    ({ sessionKey, canonicalKey, distinctKey }) => {
      const { writeMessages, messages, append, clear } = createCacheContext();
      writeMessages(sessionKey, ["first session"]);
      writeMessages(distinctKey, ["second session"]);
      expect([messages(canonicalKey), messages(distinctKey)]).toEqual([
        ["first session"],
        ["second session"],
      ]);
      append(canonicalKey, "first session update");
      const updated = ["first session", "first session update"];
      expect([messages(sessionKey), messages(distinctKey)]).toEqual([updated, ["second session"]]);
      clear(distinctKey);
      expect([messages(sessionKey), messages(distinctKey)]).toEqual([updated, []]);
    },
  );

  it("uses explicit event agent identity for global cache targets", () => {
    const { writeMessages, messages } = createCacheContext("work", {
      defaultId: "main",
      mainKey: "main",
    });
    writeMessages("global", ["work"]);
    writeMessages("global", ["main"], "main");
    expect(messages("global")).toEqual(["work"]);
    expect(messages("global", "main")).toEqual(["main"]);
  });

  it("claims a shared gateway event only once across retained panes", () => {
    const { writeMessages, append, messages } = createCacheContext();
    const target = "agent:ops:background";
    const cached = { role: "user", content: "cached", __openclaw: { id: "cached", seq: 1 } };
    const final = { role: "assistant", content: "final", __openclaw: { id: "final", seq: 2 } };
    const event = { messageId: "final", messageSeq: 2 };
    writeMessages(target, [cached]);
    append(target, final, event);
    append(target, final, event);
    expect(messages(target)).toEqual([cached, final]);
  });

  it("does not retain history across backing session changes", () => {
    const { write, read, layout: createLayout } = createCacheContext();
    write(widgetSnapshot(["old"], "session-1", { widgetHeights: { "canvas:preview": 700 } }));
    const replacement = ["new"];
    const layout = createLayout();
    write(widgetSnapshot(replacement, "session-2"));
    expect(read()?.messages).toEqual(replacement);
    layout.write("canvas:preview", 800);
    expect(layout.read("canvas:preview")).toBeUndefined();
    expect(read()?.widgetHeights).toBeUndefined();
  });

  it("retains bounded widget sizes through history refreshes within their session", () => {
    const { write, clear, layout: createLayout } = createCacheContext();
    const snapshot = widgetSnapshot();
    write(snapshot);
    const layout = createLayout();
    layout.write("canvas:preview", 700);
    write({ ...snapshot, messages: ["refreshed widget"] });
    expect(layout.read("canvas:preview")).toBe(700);
    layout.write("canvas:preview", Number.NaN);
    expect(layout.read("canvas:preview")).toBe(700);
    for (let index = 0; index < 100; index++) {
      layout.write(`canvas:${index}`, 480);
    }
    expect(layout.read("canvas:preview")).toBeUndefined();
    expect(layout.read("canvas:99")).toBe(480);
    clear();
    layout.write("canvas:99", 600);
    expect(layout.read("canvas:99")).toBeUndefined();
  });

  it("records a widget rendered before its session snapshot was cached", () => {
    const { write, read, layout: createLayout } = createCacheContext();
    const layout = createLayout();
    expect(layout.read("canvas:preview")).toBeUndefined();
    write(widgetSnapshot());
    layout.write("canvas:preview", 700);
    expect(read()?.widgetHeights).toEqual({ "canvas:preview": 700 });
  });

  it("removes an empty identity-free snapshot after a cleared session reload", () => {
    const { writeMessages, write, read } = createCacheContext();
    writeMessages("home", ["stale"]);
    write(widgetSnapshot([], null));
    expect(read()).toBeNull();
  });

  it("caps an oversized snapshot at a raw transcript boundary", () => {
    const { write, read } = createCacheContext();
    const content = "x".repeat(4 * 1024 * 1024);
    write({
      messages: [
        { content, __openclaw: { seq: 1 } },
        { content, projection: "sibling", __openclaw: { seq: 1 } },
        { content, __openclaw: { seq: 2 } },
      ],
      pagination: { hasMore: false, totalMessages: 2 },
      sessionId: "session-1",
    });
    const snapshot = read();
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.pagination).toEqual({ hasMore: true, nextOffset: 1, totalMessages: 2 });
  });

  it("evicts whole least-recently-used snapshots when the global budget is exceeded", () => {
    const { write, read } = createCacheContext();
    const content = "x".repeat(9 * 1024 * 1024);
    for (const sessionKey of ["one", "two", "three"]) {
      write(widgetSnapshot([content], sessionKey), sessionKey);
    }
    expect(read("one")).toBeNull();
    expect(read("two")).not.toBeNull();
    expect(read("three")).not.toBeNull();
  });
});
