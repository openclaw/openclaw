// Embedded gateway stub tests cover in-process gateway methods used by agent
// tools when no external gateway transport is available.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionRowProjection } from "../../gateway/session-row-projection.js";
import {
  bindEmbeddedSessionRowProjection,
  createEmbeddedCallGateway,
} from "./embedded-gateway-stub.js";

const runtime = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn((): OpenClawConfig => ({
    agents: { list: [{ id: "main", default: true }] },
  })),
  resolveSessionStoreKey: vi.fn(({ sessionKey }: { sessionKey: string }) =>
    sessionKey === "main" ? "agent:main:main" : sessionKey,
  ),
  resolveStoredSessionKeyForAgentStore: vi.fn(
    ({ agentId, sessionKey }: { agentId: string; sessionKey: string }) =>
      sessionKey === "global" || sessionKey === "unknown"
        ? sessionKey
        : sessionKey.startsWith("agent:")
          ? sessionKey
          : `agent:${agentId}:${sessionKey}`,
  ),
  searchSessionTranscripts: vi.fn(() => ({ hits: [], indexing: false, truncated: false })),
  resolveSessionStorePathCore: vi.fn(() => "/tmp/openclaw-sessions.json"),
  resolveSessionKeyFromResolveParams: vi.fn(),
  resolveSessionAgentId: vi.fn(() => "main"),
  loadSessionEntry: vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/openclaw-sessions.json",
    entry: { sessionId: "sess-main" },
    canonicalKey: "agent:main:main",
  })),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai" })),
  readChatHistoryPage: vi.fn(async () => ({
    messages: [] as unknown[],
    pagination: { offset: 0, totalMessages: 0, rawPageMessages: 0 },
  })),
  resolveChatHistoryNextOffset: vi.fn(
    ({ offset, rawPageMessages }: { offset: number; rawPageMessages: number }) =>
      offset + rawPageMessages,
  ),
  resolveEffectiveChatHistoryMaxChars: vi.fn(() => 100_000),
  getMaxChatHistoryMessagesBytes: vi.fn(() => 100_000),
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: 100_000,
  replaceOversizedChatHistoryMessages: vi.fn(({ messages }: { messages: unknown[] }) => ({
    messages,
  })),
  capArrayByJsonBytes: vi.fn((items: unknown[]) => ({ items })),
  listProjectedSessions: vi.fn(
    async (_params: { projection: SessionRowProjection; opts: unknown }) => ({ sessions: [] }),
  ),
}));

vi.mock("./embedded-gateway-stub.runtime.js", () => ({
  ...runtime,
  withPreparedSessionResolve: async (
    params: unknown,
    consume: (result: import("../../gateway/sessions-resolve.js").SessionsResolveResult) => unknown,
  ) => consume(runtime.resolveSessionKeyFromResolveParams(params)),
}));

describe("embedded gateway stub", () => {
  // The stub forwards this owner to the mocked shared operations without inspecting its rows.
  const projection = {} as SessionRowProjection;
  let unbindProjection: () => void;
  beforeEach(() => {
    unbindProjection = bindEmbeddedSessionRowProjection(Promise.resolve(projection));
    runtime.getRuntimeConfig.mockClear();
    runtime.resolveSessionKeyFromResolveParams.mockReset();
    runtime.readChatHistoryPage.mockClear();
    runtime.resolveChatHistoryNextOffset.mockClear();
    runtime.loadSessionEntry.mockClear();
    runtime.resolveSessionAgentId.mockClear();
    runtime.resolveSessionStoreKey.mockClear();
    runtime.resolveStoredSessionKeyForAgentStore.mockClear();
    runtime.searchSessionTranscripts.mockClear();
    runtime.resolveSessionStorePathCore.mockClear();
    runtime.listProjectedSessions.mockClear();
  });
  afterEach(() => unbindProjection());

  it("scopes embedded session lists to the requested agent", async () => {
    const callGateway = createEmbeddedCallGateway();
    await callGateway({
      method: "sessions.list",
      params: { agentId: "work", includeGlobal: true, search: "global" },
    });

    expect(runtime.listProjectedSessions).toHaveBeenCalledWith({
      projection,
      opts: { agentId: "work", includeGlobal: true, search: "global" },
    });
  });

  it("keeps a replacement host bound when the earlier host stops", async () => {
    const replacement = {} as SessionRowProjection;
    const unbindReplacement = bindEmbeddedSessionRowProjection(Promise.resolve(replacement));
    unbindProjection();
    try {
      await createEmbeddedCallGateway()({ method: "sessions.list" });
      expect(runtime.listProjectedSessions.mock.calls[0]?.[0].projection).toBe(replacement);
    } finally {
      unbindReplacement();
    }
    await expect(createEmbeddedCallGateway()({ method: "sessions.list" })).rejects.toThrow(
      "Embedded session projection is unavailable",
    );
  });

  it("resolves sessions through the gateway session resolver", async () => {
    runtime.resolveSessionKeyFromResolveParams.mockReturnValueOnce({
      ok: true,
      key: "agent:main:main",
    });

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{ ok: true; key: string }>({
      method: "sessions.resolve",
      params: { sessionId: "sess-main", includeGlobal: true },
    });

    expect(result).toEqual({ ok: true, key: "agent:main:main" });
    expect(runtime.resolveSessionKeyFromResolveParams).toHaveBeenCalledWith({
      projection,
      client: null,
      p: { sessionId: "sess-main", includeGlobal: true },
    });
  });

  it("preserves short-id ambiguity as a successful embedded response", async () => {
    const candidates = [
      { key: "agent:main:thread:12345678-0aaa-4000-8000-000000000001", displayName: "One" },
      { key: "agent:main:thread:12345678-0bbb-4000-8000-000000000002", displayName: "Two" },
    ];
    runtime.resolveSessionKeyFromResolveParams.mockReturnValueOnce({
      ok: true,
      ambiguous: true,
      candidates,
    });

    const callGateway = createEmbeddedCallGateway();
    await expect(
      callGateway({ method: "sessions.resolve", params: { shortId: "12345678" } }),
    ).resolves.toEqual({ ok: false, candidates });
  });

  it("throws resolver errors for unresolved sessions", async () => {
    runtime.resolveSessionKeyFromResolveParams.mockReturnValueOnce({
      ok: false,
      error: { message: "No session found: missing" },
    });

    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({
        method: "sessions.resolve",
        params: { key: "missing" },
      }),
    ).rejects.toThrow("No session found: missing");
  });

  it.each([undefined, "/stores/{agentId}.sqlite"])(
    "canonicalizes embedded session search filters with store %s",
    async (store) => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
        ...(store ? { session: { store } } : {}),
      };
      const storePath = store ? "/stores/main.sqlite" : "/tmp/openclaw-sessions.json";
      runtime.getRuntimeConfig.mockReturnValueOnce(cfg);
      runtime.resolveSessionStorePathCore.mockReturnValueOnce(storePath);
      const callGateway = createEmbeddedCallGateway();
      await callGateway({
        method: "sessions.search",
        params: {
          agentId: "main",
          query: "needle",
          sessionKeys: ["main", "agent:main:other"],
          limit: 3,
        },
      });

      expect(runtime.resolveStoredSessionKeyForAgentStore).toHaveBeenNthCalledWith(1, {
        cfg,
        agentId: "main",
        sessionKey: "main",
      });
      expect(runtime.resolveStoredSessionKeyForAgentStore).toHaveBeenNthCalledWith(2, {
        cfg,
        agentId: "main",
        sessionKey: "agent:main:other",
      });
      expect(runtime.searchSessionTranscripts).toHaveBeenCalledWith({
        agentId: "main",
        query: "needle",
        limit: 3,
        sessionKeys: ["agent:main:main", "agent:main:other"],
        storePath,
      });
      expect(runtime.resolveSessionStorePathCore).toHaveBeenCalledWith(store, { agentId: "main" });
    },
  );

  it.each(["main", "ops"])(
    "resolves omitted search filters through the fixed-store owner %s",
    async (agentId) => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "main", default: true }, { id: "ops" }],
          defaults: { sessionStore: { agentId } },
        },
        session: { store: "/stores/shared.sqlite" },
      };
      runtime.getRuntimeConfig.mockReturnValueOnce(cfg);
      runtime.resolveSessionAgentId.mockReturnValueOnce(agentId);
      runtime.resolveSessionStorePathCore.mockReturnValueOnce("/stores/shared.sqlite");

      await createEmbeddedCallGateway()({ method: "sessions.search", params: { query: "needle" } });

      expect(runtime.resolveSessionAgentId).toHaveBeenCalledWith({
        sessionKey: "main",
        config: cfg,
      });
      expect(runtime.listProjectedSessions).not.toHaveBeenCalled();
      expect(runtime.searchSessionTranscripts).toHaveBeenCalledWith({
        agentId,
        query: "needle",
        limit: undefined,
        sessionKeys: undefined,
        storePath: "/stores/shared.sqlite",
      });
    },
  );

  it("rejects empty session-key filters instead of widening the search", async () => {
    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({ method: "sessions.search", params: { query: "needle", sessionKeys: [] } }),
    ).rejects.toThrow("sessionKeys must be a non-empty array of session keys");
    await expect(
      callGateway({ method: "sessions.search", params: { query: "needle", sessionKeys: [7] } }),
    ).rejects.toThrow("sessionKeys must be a non-empty array of session keys");
    expect(runtime.searchSessionTranscripts).not.toHaveBeenCalled();
  });

  it("rejects oversized embedded session search queries", async () => {
    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({ method: "sessions.search", params: { query: "x".repeat(4097) } }),
    ).rejects.toThrow("query must not exceed 4096 characters");
    expect(runtime.searchSessionTranscripts).not.toHaveBeenCalled();
  });

  it("rejects an explicit agent that conflicts with an unscoped store owner", async () => {
    runtime.resolveSessionAgentId.mockImplementationOnce(() => {
      throw new Error('The shared fixed-store row belongs to "ops", not "research".');
    });
    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({
        method: "sessions.search",
        params: { agentId: "research", query: "needle", sessionKeys: ["global"] },
      }),
    ).rejects.toThrow('belongs to "ops", not "research"');
    expect(runtime.resolveSessionAgentId).toHaveBeenCalledWith({
      sessionKey: "global",
      config: { agents: { list: [{ id: "main", default: true }] } },
      agentId: "research",
    });
    expect(runtime.searchSessionTranscripts).not.toHaveBeenCalled();
  });

  it("reads embedded history through the canonical Gateway history owner", async () => {
    const messages = [{ role: "assistant", content: "visible past a silent tail" }];
    runtime.readChatHistoryPage.mockResolvedValueOnce({
      messages,
      pagination: { offset: 0, totalMessages: 81, rawPageMessages: 81 },
    });

    const result = await createEmbeddedCallGateway()<{ messages: unknown[] }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 1 },
    });

    expect(result.messages).toEqual(messages);
    expect(result).not.toHaveProperty("offset");
  });

  it.each([
    { sessionKey: "global", agentId: "work" },
    { sessionKey: "agent:work:main", agentId: undefined },
  ])("scopes embedded chat history to its requested agent", async ({ sessionKey, agentId }) => {
    await createEmbeddedCallGateway()({
      method: "chat.history",
      params: { sessionKey, ...(agentId ? { agentId } : {}) },
    });

    expect(runtime.loadSessionEntry).toHaveBeenCalledWith(sessionKey, { agentId: "work" });
    expect(runtime.resolveSessionAgentId).toHaveBeenCalledWith({
      sessionKey,
      config: {},
      agentId: "work",
    });
  });

  it("preserves bounded offset metadata from the shared visible-history scanner", async () => {
    const messages = [{ role: "assistant", content: "older visible", __openclaw: { seq: 2 } }];
    runtime.readChatHistoryPage.mockResolvedValueOnce({
      messages,
      pagination: { offset: 1, totalMessages: 82, rawPageMessages: 80 },
    });

    const result = await createEmbeddedCallGateway()<{
      messages: unknown[];
      offset: number;
      nextOffset: number;
      hasMore: boolean;
      totalMessages: number;
    }>({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 1, offset: 1 },
    });

    expect(runtime.readChatHistoryPage).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 1, max: 1 }),
    );
    expect(result).toMatchObject({
      messages,
      offset: 1,
      nextOffset: 81,
      hasMore: true,
      totalMessages: 82,
    });
  });

  it("computes continuation from the final byte-budgeted visible page", async () => {
    const messages = [
      { role: "assistant", content: "older", __openclaw: { seq: 6 } },
      { role: "assistant", content: "latest", __openclaw: { seq: 7 } },
    ];
    const bounded = [messages[1]];
    runtime.readChatHistoryPage.mockResolvedValueOnce({
      messages,
      pagination: { offset: 0, totalMessages: 10, rawPageMessages: 5 },
    });
    runtime.capArrayByJsonBytes.mockReturnValueOnce({ items: bounded });
    runtime.resolveChatHistoryNextOffset.mockReturnValueOnce(3);

    const result = await createEmbeddedCallGateway()({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 2, offset: 0 },
    });

    expect(runtime.resolveChatHistoryNextOffset).toHaveBeenCalledWith({
      messages: bounded,
      totalMessages: 10,
      offset: 0,
      rawPageMessages: 5,
      projected: messages,
    });
    expect(result).toMatchObject({ messages: bounded, nextOffset: 3, hasMore: true });
  });

  it("normalizes string history limits before calling the shared owner", async () => {
    await createEmbeddedCallGateway()({
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: "2" },
    });

    expect(runtime.readChatHistoryPage).toHaveBeenCalledWith(expect.objectContaining({ max: 2 }));
  });

  it.each(["2.5", -1])("rejects malformed history limit %j before reading", async (limit) => {
    await expect(
      createEmbeddedCallGateway()({
        method: "chat.history",
        params: { sessionKey: "agent:main:main", limit },
      }),
    ).rejects.toThrow("limit must be a positive integer");
    expect(runtime.readChatHistoryPage).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, "1abc"])(
    "rejects malformed history offset %j before reading",
    async (offset) => {
      await expect(
        createEmbeddedCallGateway()({
          method: "chat.history",
          params: { sessionKey: "agent:main:main", offset },
        }),
      ).rejects.toThrow("offset must be a non-negative integer");
      expect(runtime.readChatHistoryPage).not.toHaveBeenCalled();
    },
  );
});
