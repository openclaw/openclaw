import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistoryPage } from "../../config/sessions/session-history-types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { decodeChatHistoryPageCursor } from "../../gateway/server-methods/chat-history-page-cursor.js";
import { prepareChatHistoryResponsePage } from "../../gateway/server-methods/chat-history-response-page.js";
import type { SessionRowProjection } from "../../gateway/session-row-projection.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  bindEmbeddedSessionRowProjection,
  createEmbeddedCallGateway,
} from "./embedded-gateway-stub.js";

const runtime = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn((): OpenClawConfig => ({
    agents: { entries: { main: {} } },
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
  loadGatewaySessionEntryReadOnlyInWorker: vi.fn(async () => ({
    cfg: {},
    storePath: "/tmp/openclaw-sessions.json",
    entry: { sessionId: "sess-main" },
    canonicalKey: "agent:main:main",
  })),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai" })),
  readChatHistoryPage: vi.fn(async (): Promise<ChatHistoryPage> => ({
    messages: [] as unknown[],
    pagination: { offset: 0, totalMessages: 0, rawPageMessages: 0 },
  })),
  resolveSessionKeyBySessionIdAsync: vi.fn(
    async (): Promise<string | undefined> => "agent:main:main",
  ),
  resolveEffectiveChatHistoryMaxChars: vi.fn(() => 100_000),
  getMaxChatHistoryMessagesBytes: vi.fn(() => 6 * 1024 * 1024),
  listProjectedSessions: vi.fn(
    async (_params: { projection: SessionRowProjection; opts: unknown }) => ({ sessions: [] }),
  ),
}));

// mock-isolation: Keep storage and session lifecycles synthetic, with the real response owner.
vi.mock("./embedded-gateway-stub.runtime.js", () => ({
  ...runtime,
  decodeChatHistoryPageCursor,
  prepareChatHistoryResponsePage,
  withPreparedSessionResolve: async (
    {
      isCurrent,
      ...params
    }: {
      projection: SessionRowProjection;
      isCurrent?: () => boolean;
    },
    consume: (result: import("../../gateway/sessions-resolve.js").SessionsResolveResult) => unknown,
  ) => {
    await params.projection.ensureMaterialized();
    if (isCurrent?.() === false) {
      throw new Error("Session projection changed while resolving the session; retry the request");
    }
    return consume(runtime.resolveSessionKeyFromResolveParams(params));
  },
}));

function request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>) {
  return createEmbeddedCallGateway()<T>({ method, params });
}
function history<T = Record<string, unknown>>(params: Record<string, unknown>) {
  return request<T>("chat.history", { sessionKey: "agent:main:main", ...params });
}
async function rejectHistory(params: Record<string, unknown>, message: string) {
  await expect(history(params)).rejects.toThrow(message);
  expect(runtime.readChatHistoryPage).not.toHaveBeenCalled();
}

describe("embedded gateway stub", () => {
  // The prepared resolver owns readiness; the stub retains its host binding.
  const projection = {
    ensureMaterialized: async () => {},
  } as SessionRowProjection;
  let unbindProjection: () => void;
  beforeEach(() => {
    unbindProjection = bindEmbeddedSessionRowProjection(Promise.resolve(projection));
    for (const mock of Object.values(runtime)) {
      mock.mockClear();
    }
    runtime.resolveSessionKeyFromResolveParams.mockReset();
    runtime.resolveSessionKeyBySessionIdAsync.mockReset();
    runtime.resolveSessionKeyBySessionIdAsync.mockResolvedValue("agent:main:main");
  });
  afterEach(() => unbindProjection());

  it("scopes embedded session lists to the requested agent", async () => {
    await request("sessions.list", { agentId: "work", includeGlobal: true, search: "global" });

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
      await request("sessions.list");
      expect(runtime.listProjectedSessions.mock.calls[0]?.[0].projection).toBe(replacement);
    } finally {
      unbindReplacement();
    }
    await expect(request("sessions.list")).rejects.toThrow(
      "Embedded session projection is unavailable",
    );
  });

  it("resolves sessions through the gateway session resolver", async () => {
    runtime.resolveSessionKeyFromResolveParams.mockReturnValueOnce({
      ok: true,
      key: "agent:main:main",
    });

    const result = await request<{ ok: true; key: string }>("sessions.resolve", {
      sessionId: "sess-main",
      includeGlobal: true,
    });

    expect(result).toEqual({ ok: true, key: "agent:main:main" });
    expect(runtime.resolveSessionKeyFromResolveParams).toHaveBeenCalledWith({
      projection,
      client: null,
      p: { sessionId: "sess-main", includeGlobal: true },
    });
  });

  it("rejects a host replacement while session resolution prepares rows", async () => {
    const preparing = createDeferredCore();
    const release = createDeferredCore();
    const prepare = vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
      preparing.resolve();
      await release.promise;
    });
    runtime.resolveSessionKeyFromResolveParams.mockReturnValue({
      ok: true,
      key: "agent:main:main",
    });
    const pending = request("sessions.resolve", { sessionId: "sess-main" });
    const settled = Promise.allSettled([pending]);
    let unbindReplacement: (() => void) | undefined;
    try {
      await Promise.race([preparing.promise, pending]);
      unbindReplacement = bindEmbeddedSessionRowProjection(Promise.resolve(projection));
      release.resolve();
      await expect(pending).rejects.toThrow(
        "Session projection changed while resolving the session",
      );
      expect(runtime.resolveSessionKeyFromResolveParams).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await settled;
      prepare.mockRestore();
      unbindReplacement?.();
    }
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

    await expect(request("sessions.resolve", { shortId: "12345678" })).resolves.toEqual({
      ok: false,
      candidates,
    });
  });

  it("throws resolver errors for unresolved sessions", async () => {
    runtime.resolveSessionKeyFromResolveParams.mockReturnValueOnce({
      ok: false,
      error: { message: "No session found: missing" },
    });

    await expect(request("sessions.resolve", { key: "missing" })).rejects.toThrow(
      "No session found: missing",
    );
  });

  it.each([undefined, "/stores/{agentId}.sqlite"])(
    "canonicalizes embedded session search filters with store %s",
    async (store) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        ...(store ? { session: { store } } : {}),
      };
      const storePath = store ? "/stores/main.sqlite" : "/tmp/openclaw-sessions.json";
      runtime.getRuntimeConfig.mockReturnValueOnce(cfg);
      runtime.resolveSessionStorePathCore.mockReturnValueOnce(storePath);
      await request("sessions.search", {
        agentId: "main",
        query: "needle",
        sessionKeys: ["main", "agent:main:other"],
        limit: 3,
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

  it("resolves omitted search filters through the fixed-store owner", async () => {
    const agentId = "ops";
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {}, ops: {} },
        defaults: { sessionStore: { agentId } },
      },
      session: { store: "/stores/shared.sqlite" },
    };
    runtime.getRuntimeConfig.mockReturnValueOnce(cfg);
    runtime.resolveSessionAgentId.mockReturnValueOnce(agentId);
    runtime.resolveSessionStorePathCore.mockReturnValueOnce("/stores/shared.sqlite");

    await request("sessions.search", { query: "needle" });

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
  });

  it("rejects empty session-key filters instead of widening the search", async () => {
    await expect(request("sessions.search", { query: "needle", sessionKeys: [] })).rejects.toThrow(
      "sessionKeys must be a non-empty array of session keys",
    );
    await expect(request("sessions.search", { query: "needle", sessionKeys: [7] })).rejects.toThrow(
      "sessionKeys must be a non-empty array of session keys",
    );
    expect(runtime.searchSessionTranscripts).not.toHaveBeenCalled();
  });

  it("rejects oversized embedded session search queries", async () => {
    await expect(request("sessions.search", { query: "x".repeat(4097) })).rejects.toThrow(
      "query must not exceed 4096 characters",
    );
    expect(runtime.searchSessionTranscripts).not.toHaveBeenCalled();
  });

  it("rejects an explicit agent that conflicts with an unscoped store owner", async () => {
    runtime.resolveSessionAgentId.mockImplementationOnce(() => {
      throw new Error('The shared fixed-store row belongs to "ops", not "research".');
    });

    await expect(
      request("sessions.search", { agentId: "research", query: "needle", sessionKeys: ["global"] }),
    ).rejects.toThrow('belongs to "ops", not "research"');
    expect(runtime.resolveSessionAgentId).toHaveBeenCalledWith({
      sessionKey: "global",
      config: { agents: { entries: { main: {} } } },
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

    const result = await history<{ messages: unknown[] }>({ limit: 1 });

    expect(result.messages).toEqual(messages);
    expect(result).not.toHaveProperty("offset");
  });

  it.each([
    { sessionKey: "global", agentId: "work" },
    { sessionKey: "agent:work:main", agentId: undefined },
  ])("scopes embedded chat history to its requested agent", async ({ sessionKey, agentId }) => {
    await history({ sessionKey, ...(agentId ? { agentId } : {}) });

    expect(runtime.loadGatewaySessionEntryReadOnlyInWorker).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      key: sessionKey,
      agentId: "work",
    });
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

    const result = await history<{
      messages: unknown[];
      offset: number;
      nextOffset: number;
      hasMore: boolean;
      totalMessages: number;
    }>({ limit: 1, offset: 1 });

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

  it.each([undefined, "205000"])(
    "bounds embedded history and continues from retained rows with maxBytes %s",
    async (maxBytes) => {
      const messages = Array.from({ length: 6 }, (_, index) => ({
        role: "assistant",
        content: "x".repeat(100_000),
        __openclaw: { id: `message-${index + 1}`, seq: index + 1 },
      }));
      runtime.readChatHistoryPage.mockResolvedValueOnce({
        messages,
        pagination: { offset: 0, totalMessages: 6, rawPageMessages: 6 },
      });

      const result = await history({ limit: 6, offset: 0, maxBytes });
      const count = maxBytes === undefined ? 5 : 2;
      expect(result).toMatchObject({
        messages: messages.slice(-count),
        nextOffset: count,
        hasMore: true,
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        maxBytes === undefined ? 512 * 1024 : Number(maxBytes),
      );
      expect(result).not.toHaveProperty("messagesBytes");
    },
  );

  it("continues a retained anchored page through its original transcript source", async () => {
    const cursor = {
      sessionId: "retained-session",
      source: "reset-archive",
      messageId: "message-3",
      direction: "older" as const,
    };
    const messages = [
      { role: "assistant", content: "earlier", __openclaw: { id: "message-2", seq: 2 } },
    ];
    const initial = prepareChatHistoryResponsePage(
      {
        messages: [
          { role: "assistant", content: "Anchor", __openclaw: { id: cursor.messageId, seq: 3 } },
        ],
        anchor: {
          sessionId: cursor.sessionId,
          source: cursor.source,
          hasOlder: true,
          hasNewer: false,
        },
      },
      { entry: undefined, maxHistoryBytes: 512 * 1024, messageId: cursor.messageId },
    );
    runtime.readChatHistoryPage.mockResolvedValueOnce({
      messages,
      anchor: {
        sessionId: cursor.sessionId,
        source: cursor.source,
        direction: cursor.direction,
        hasOlder: true,
        hasNewer: true,
      },
    });
    const result = await history<{
      messages: unknown[];
      sessionId: string;
      olderCursor: string;
    }>({ cursor: initial.olderCursor });
    expect(result.messages).toEqual(messages);
    expect(result.sessionId).toBe(cursor.sessionId);
    expect(decodeChatHistoryPageCursor(result.olderCursor)).toEqual({
      ...cursor,
      messageId: "message-2",
    });
    expect(runtime.readChatHistoryPage).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: undefined,
        sessionId: cursor.sessionId,
        messageId: cursor.messageId,
        pageCursor: cursor,
      }),
    );
  });

  it.each([
    { cursor: "delta:current", message: "delta cursors require a running gateway" },
    { cursor: "history-page:invalid", message: "invalid history page cursor" },
  ])(
    "rejects unsupported or invalid cursor $cursor before reading",
    async ({ cursor, message }) => {
      await rejectHistory({ cursor }, message);
    },
  );

  it("normalizes string history limits before calling the shared owner", async () => {
    await history({ limit: "2" });

    expect(runtime.readChatHistoryPage).toHaveBeenCalledWith(expect.objectContaining({ max: 2 }));
  });

  it.each(["2.5", -1])("rejects malformed history limit %j before reading", async (limit) => {
    await rejectHistory({ limit }, "limit must be a positive integer");
  });

  it.each([-1, 1.5, "1abc"])(
    "rejects malformed history offset %j before reading",
    async (offset) => {
      await rejectHistory({ offset }, "offset must be a non-negative integer");
    },
  );
});
