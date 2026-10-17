// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  clearChatMessagesFromCache,
  createChatWidgetLayout,
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
    layout: () => createChatWidgetLayout(cache, host, target()),
  };
}

const widgetSnapshot = (
  messages: unknown[] = ["widget"],
  sessionId: string | null = "session-1",
  extras: Partial<ChatSessionSnapshot> = {},
): ChatSessionSnapshot => ({ messages, pagination: { hasMore: false }, sessionId, ...extras });

describe("session message cache", () => {
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
