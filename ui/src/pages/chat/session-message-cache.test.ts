// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { cacheChatBoardSnapshotAfterHydration } from "./chat-board-snapshot.ts";
import { captureChatDetailsSnapshot, projectDetailsSubagents } from "./chat-details-snapshot.ts";
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
  const cache: ChatMessageCache = new Map();
  const host = {
    assistantAgentId,
    agentsList,
    chatMessagesBySession: cache,
    sessionKey: "home",
    currentSessionId: "session-1",
    connected: true,
    connectionEpoch: 0,
    settings: { gatewayUrl: "wss://cache.example" },
    client: { recoveryScope: "account-a", recoveryScopeReady: true },
  };
  const target = (sessionKey = "home", agentId?: string) => ({ sessionKey, agentId });
  const read = (sessionKey = "home") => readChatSessionSnapshot(cache, host, target(sessionKey));
  const write = (snapshot: ChatSessionSnapshot, sessionKey = "home") =>
    cacheChatSessionSnapshot(cache, host, target(sessionKey), snapshot);
  return {
    cache,
    host,
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
  it("publishes changed older edges without inventing numeric coverage", () => {
    const { cache, write, read } = createCacheContext();
    const persisted = vi.fn();
    observeChatCache(cache, { write: persisted, delete: vi.fn() });
    const messages = ["held source group"];
    const snapshot = widgetSnapshot(messages);
    write({ ...snapshot, pagination: { hasMore: true, olderCursor: "older-A" } });
    write({ ...snapshot, pagination: { hasMore: true, olderCursor: "older-B" } });
    expect(read()?.pagination).toEqual({ hasMore: true, olderCursor: "older-B" });
    write({ ...snapshot, pagination: { hasMore: true, needsBoundary: true } });
    write({ ...snapshot, pagination: { hasMore: true, needsBoundary: true } });
    expect(persisted).toHaveBeenCalledTimes(3);
    expect(read()?.pagination).toEqual({ hasMore: true, needsBoundary: true });
    expect(read()?.messages).toBe(messages);
  });

  it("persists changed session display facts once without repeating unchanged writes", () => {
    const { cache, write, read } = createCacheContext();
    const persisted = vi.fn();
    observeChatCache(cache, { write: persisted, delete: vi.fn() });
    const sessionState = { archived: true, unarchiveAllowed: true, parentSession: null };
    const snapshot = widgetSnapshot(["saved conversation"], "session-1", { sessionState });
    write(snapshot);
    write({ ...snapshot, sessionState: { ...sessionState } });
    expect(persisted).toHaveBeenCalledTimes(1);
    write({ ...snapshot, sessionState: { ...sessionState, archived: false } });
    expect(persisted).toHaveBeenCalledTimes(2);
    expect(read()?.sessionState?.archived).toBe(false);
  });

  it("publishes each admitted snapshot once with its pruned thumbnail weight", () => {
    const { cache, read, write, append } = createCacheContext();
    const thumbnail = new Blob([new Uint8Array(256 * 1024)], { type: "image/webp" });
    const image = { width: 480, height: 240, rendition: 480 as const, thumbnail };
    const messages = Array.from({ length: 34 }, (_, index) => ({
      role: "assistant",
      content: "Synthetic image",
      __openclaw: { id: `image-${index}`, seq: index + 1 },
    }));
    const publish = vi.fn((_key: string, value: ChatSessionSnapshot, weight: number) => {
      expect(weight).toBe(JSON.stringify(value).length);
    });
    observeChatCache(cache, { write: publish, delete: vi.fn() });
    write(
      widgetSnapshot(messages, "session-1", {
        rowDisplay: Object.fromEntries(
          messages.map((_, index) => [`image-${index}`, { images: { source: image } }]),
        ),
      }),
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(read()?.messages).toBe(messages);
    expect(
      Object.values(read()?.rowDisplay ?? {}).filter((row) => row.images?.source?.thumbnail),
    ).toHaveLength(32);
    append("home", {
      role: "assistant",
      content: "Following message",
      __openclaw: { id: "following", seq: 35 },
    });
    expect(publish).toHaveBeenCalledTimes(2);
    write(
      widgetSnapshot(
        [{ role: "assistant", content: "Other", __openclaw: { id: "other" } }],
        "two",
        { rowDisplay: { other: { images: { source: image } } } },
      ),
      "other",
    );
    expect(publish).toHaveBeenCalledTimes(4);
    expect(
      Object.values(read()?.rowDisplay ?? {}).filter((row) => row.images?.source?.thumbnail),
    ).toHaveLength(31);
  });

  it.each([
    { messageReactions: { reply: [{ emoji: "👍", count: 1, identities: [{ id: "peer" }] }] } },
    { composer: { id: "saved", provider: "example", name: "Saved", permissionMode: "full" } },
    { rowDisplay: { reply: { links: { source: { title: "Saved title" } } } } },
    { rowDisplay: { reply: { images: { source: { width: 480, height: 240, rendition: 480 } } } } },
    { avatarSources: { ops: "/avatar/ops?v=1", cleared: null } },
    {
      headerViewers: { users: [{ id: "peer", name: "Peer" }], totalCount: 5, ownerViewing: false },
      headerSharing: "public",
      sessionState: { archived: true, unarchiveAllowed: false },
    },
    {
      details: {
        locale: "en",
        subagents: { total: 0, rows: [], counts: [] },
        automations: { rows: [], more: false },
        outputs: 1,
      },
    },
  ] satisfies Partial<ChatSessionSnapshot>[])("retains %j across the same incarnation", (facts) => {
    const { read, write } = createCacheContext();
    const messages = [{ role: "assistant", content: "Cached", __openclaw: { id: "reply" } }];
    write(widgetSnapshot(messages, "session-1", facts));
    write(widgetSnapshot(messages.slice(), "session-1"));
    expect(read()).toMatchObject(facts);
    write(widgetSnapshot(["reset"], "session-2"));
    expect(read()).toMatchObject({ messages: ["reset"], sessionId: "session-2" });
    expect(
      Object.entries(read() ?? {}).filter(
        ([field, value]) => field in facts && value !== undefined,
      ),
    ).toEqual([]);
  });

  it("merges current-locale Details receipts without overwriting row footprints", () => {
    const { host, read, write, layout } = createCacheContext();
    write(
      widgetSnapshot([], "session-1", {
        details: { locale: "other-locale", automations: { rows: [], more: false } },
      }),
    );
    const receipt = captureChatDetailsSnapshot(host)!;
    expect(receipt.details).toBeUndefined();
    receipt.write({ subagents: { total: 0, rows: [], counts: [] } });
    const widgetHeights = { 'row:v1:768:appearance:revision:"reply"': 200 };
    layout().writeRows(widgetHeights);
    receipt.write({ outputs: 2 });
    expect(read()?.details).toEqual({
      locale: i18n.getLocale(),
      subagents: { total: 0, rows: [], counts: [] },
      outputs: 2,
    });
    expect(read()?.widgetHeights).toEqual(widgetHeights);
  });

  it.each<[string, (host: ReturnType<typeof createCacheContext>["host"]) => void]>([
    ["connection epoch", (host) => Object.assign(host, { connectionEpoch: 1 })],
    [
      "account scope on the same client",
      (host) => Object.assign(host.client, { recoveryScope: "other" }),
    ],
    ["connection client", (host) => Object.assign(host, { client: { ...host.client } })],
    ["disconnect", (host) => Object.assign(host, { connected: false })],
    ["session incarnation", (host) => Object.assign(host, { currentSessionId: "replacement" })],
    ["selected session", (host) => Object.assign(host, { sessionKey: "other" })],
  ])("rejects a late Details receipt after %s changes", (_, change) => {
    const { host, read, write } = createCacheContext();
    write(widgetSnapshot());
    const receipt = captureChatDetailsSnapshot(host)!;
    change(host);
    write(widgetSnapshot());
    receipt.write({ outputs: 99 });
    expect(read()?.details).toBeUndefined();
  });

  it("bounds Subagents to display fields, prioritizing working rows and counting every row", () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({
      key: String(index),
      label: "Worker",
      status: index === 5 ? ("running" as const) : ("done" as const),
      transcript: "not display data",
    }));
    expect(projectDetailsSubagents(rows)).toEqual({
      total: 6,
      rows: [5, 0, 1, 2].map((index) => ({
        key: String(index),
        label: "Worker",
        status: index === 5 ? "running" : "done",
      })),
      counts: [
        { status: "running", count: 1 },
        { status: "done", count: 5 },
      ],
    });
  });

  it("publishes a footprint batch once and rejects a retired session's deferred batch", () => {
    const { cache, read, write, layout: createLayout } = createCacheContext();
    write(widgetSnapshot([], "one"));
    const layout = createLayout();
    expect(layout.readRows()).toBeUndefined();
    const publish = vi.fn();
    observeChatCache(cache, { write: publish, delete: vi.fn() });
    const heights = {
      'row:v1:768:appearance:first:"one"': 100,
      'row:v1:768:appearance:second:"two"': 200,
    };
    layout.writeRows(heights);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(read()?.widgetHeights).toEqual(heights);
    // Newly measured rows belong to the next reload, not this admission.
    expect(layout.readRows()).toBeUndefined();
    const reloaded = createLayout();
    expect(reloaded.readRows()).toEqual(heights);
    layout.writeRows(heights);
    expect(publish).toHaveBeenCalledTimes(1);
    write(widgetSnapshot([], "two"));
    publish.mockClear();
    layout.writeRows(heights);
    expect(publish).not.toHaveBeenCalled();
    expect(read()?.widgetHeights).toBeUndefined();
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
      widgetSnapshot([], "one", { widgetHeights: { [row]: 100 }, headerSharing: "public" }),
    );
    const layout = createChatWidgetLayout()(cache, host, target);
    expect(layout.readRows()).toEqual({ [row]: 100 });
    host.client.recoveryScope = "account-b";
    expect(readChatSessionSnapshot(cache, host, target)).toBeNull();
    cacheChatSessionSnapshot(
      cache,
      host,
      target,
      widgetSnapshot([], "one", { widgetHeights: { [row]: 200 } }),
    );
    expect(readChatSessionSnapshot(cache, host, target)?.headerSharing).toBeUndefined();
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
    const { cache, write, read } = createCacheContext();
    observeChatCache(cache, {
      write: (_key, snapshot, weight) => expect(weight).toBe(JSON.stringify(snapshot).length),
      delete: vi.fn(),
    });
    const content = "x".repeat(4 * 1024 * 1024);
    write({
      messages: [
        { role: "assistant", content, __openclaw: { id: "first", seq: 1 } },
        {
          role: "assistant",
          content,
          projection: "sibling",
          __openclaw: { id: "sibling", seq: 1 },
        },
        { role: "assistant", content, __openclaw: { id: "last", seq: 2 } },
      ],
      rowDisplay: {
        first: { links: { source: { title: "First linked task" } } },
        last: { links: { source: { title: "Last linked task" } } },
      },
      pagination: { hasMore: false, totalMessages: 2 },
      sessionId: "session-1",
    });
    const snapshot = read();
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.pagination).toEqual({ hasMore: true, needsBoundary: true, totalMessages: 2 });
    expect(snapshot?.rowDisplay).toEqual({
      last: { links: { source: { title: "Last linked task" } } },
    });
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
