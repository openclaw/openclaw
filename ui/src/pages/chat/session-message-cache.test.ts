import { describe, expect, it } from "vitest";
import {
  appendChatMessageToCache,
  cacheChatMessages,
  cacheChatSessionSnapshot,
  readChatMessagesFromCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";

function createHost() {
  return {
    assistantAgentId: "ops",
    agentsList: { defaultId: "ops", mainKey: "home" },
  };
}

describe("session message cache", () => {
  it("canonicalizes main aliases without crossing agent scopes", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();

    cacheChatMessages(cache, host, { sessionKey: "home" }, ["ops"]);

    expect(readChatMessagesFromCache(cache, host, { sessionKey: "agent:ops:home" })).toEqual([
      "ops",
    ]);
    expect(readChatMessagesFromCache(cache, host, { sessionKey: "agent:ops:main" })).toEqual([
      "ops",
    ]);
    expect(readChatMessagesFromCache(cache, host, { sessionKey: "agent:main:home" })).toEqual([]);
  });

  it("uses explicit event agent identity for global cache targets", () => {
    const host = {
      assistantAgentId: "work",
      agentsList: { defaultId: "main", mainKey: "main" },
    };
    const cache: ChatMessageCache = new Map();

    cacheChatMessages(cache, host, { sessionKey: "global" }, ["work"]);
    cacheChatMessages(cache, host, { sessionKey: "global", agentId: "main" }, ["main"]);

    expect(readChatMessagesFromCache(cache, host, { sessionKey: "global" })).toEqual(["work"]);
    expect(
      readChatMessagesFromCache(cache, host, { sessionKey: "global", agentId: "main" }),
    ).toEqual(["main"]);
  });

  it("keeps only the 20 most recently used sessions", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    for (let index = 0; index < 20; index += 1) {
      cacheChatMessages(cache, host, { sessionKey: `agent:ops:session-${index}` }, [index]);
    }

    readChatMessagesFromCache(cache, host, { sessionKey: "agent:ops:session-0" });
    cacheChatMessages(cache, host, { sessionKey: "agent:ops:session-20" }, [20]);
    cacheChatMessages(cache, host, { sessionKey: "agent:ops:large" }, [21]);

    expect(cache.size).toBe(20);
    expect(cache.has("agent:ops:session-0")).toBe(true);
    expect(cache.has("agent:ops:session-1")).toBe(false);
    expect(readChatMessagesFromCache(cache, host, { sessionKey: "agent:ops:large" })).toEqual([21]);
  });

  it("restores messages, pagination, and backing session identity together", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: ["oldest", "latest"],
        pagination: { hasMore: true, nextOffset: 400, totalMessages: 718 },
        sessionId: "session-1",
      },
    );

    expect(readChatSessionSnapshot(cache, host, { sessionKey: "home" })).toEqual({
      messages: ["oldest", "latest"],
      pagination: { hasMore: true, nextOffset: 400, totalMessages: 718 },
      sessionId: "session-1",
    });
  });

  it("appends an inactive-session message without losing snapshot metadata", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: ["oldest"],
        pagination: { hasMore: true, nextOffset: 400, totalMessages: 718 },
        sessionId: "session-1",
      },
    );

    appendChatMessageToCache(cache, host, { sessionKey: "home" }, "latest");

    expect(readChatSessionSnapshot(cache, host, { sessionKey: "home" })).toEqual({
      messages: ["oldest", "latest"],
      pagination: { hasMore: true, nextOffset: 400, totalMessages: 718 },
      sessionId: "session-1",
    });
  });

  it("removes an empty identity-free snapshot after a cleared session reload", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    cacheChatMessages(cache, host, { sessionKey: "home" }, ["stale"]);

    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: [],
        pagination: { hasMore: false },
        sessionId: null,
      },
    );

    expect(readChatSessionSnapshot(cache, host, { sessionKey: "home" })).toBeNull();
  });

  it("caps an oversized snapshot at a raw transcript boundary", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    const content = "x".repeat(4 * 1024 * 1024);
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey: "home" },
      {
        messages: [
          { content, __openclaw: { seq: 1 } },
          { content, projection: "sibling", __openclaw: { seq: 1 } },
          { content, __openclaw: { seq: 2 } },
        ],
        pagination: { hasMore: false, totalMessages: 2 },
        sessionId: "session-1",
      },
    );

    const snapshot = readChatSessionSnapshot(cache, host, { sessionKey: "home" });
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.pagination).toEqual({
      hasMore: true,
      nextOffset: 1,
      totalMessages: 2,
    });
  });

  it("evicts whole least-recently-used snapshots when the global budget is exceeded", () => {
    const host = createHost();
    const cache: ChatMessageCache = new Map();
    const content = "x".repeat(9 * 1024 * 1024);
    for (const sessionKey of ["one", "two", "three"]) {
      cacheChatSessionSnapshot(
        cache,
        host,
        { sessionKey },
        {
          messages: [{ content, __openclaw: { seq: 1 } }],
          pagination: { hasMore: false, totalMessages: 1 },
          sessionId: sessionKey,
        },
      );
    }

    expect(readChatSessionSnapshot(cache, host, { sessionKey: "one" })).toBeNull();
    expect(readChatSessionSnapshot(cache, host, { sessionKey: "two" })).not.toBeNull();
    expect(readChatSessionSnapshot(cache, host, { sessionKey: "three" })).not.toBeNull();
  });
});
