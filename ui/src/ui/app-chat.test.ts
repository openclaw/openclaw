/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSendChat, refreshChat, refreshChatAvatar, type ChatHost } from "./app-chat.ts";

function makeHost(overrides?: Partial<ChatHost>): ChatHost {
  return {
    client: null,
    chatMessages: [],
    chatStream: null,
    connected: true,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    lastError: null,
    sessionKey: "agent:main",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    chatModelOverrides: {},
    chatModelsLoading: false,
    chatModelCatalog: [],
    refreshSessionsAfterChat: new Set<string>(),
    updateComplete: Promise.resolve(),
    ...overrides,
  };
}

describe("refreshChatAvatar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a route-relative avatar endpoint before basePath bootstrap finishes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ avatarUrl: "/avatar/main" }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:main" });
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledWith(
      "avatar/main?meta=1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(host.chatAvatarUrl).toBe("/avatar/main");
  });

  it("keeps mounted dashboard avatar endpoints under the normalized base path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "/openclaw/", sessionKey: "agent:ops:main" });
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledWith(
      "/openclaw/avatar/ops?meta=1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(host.chatAvatarUrl).toBeNull();
  });
});

describe("handleSendChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps slash-command model changes in sync with the chat header cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }) as unknown as typeof fetch,
    );
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          key: "main",
          resolved: {
            modelProvider: "openai",
            model: "gpt-5-mini",
          },
        };
      }
      if (method === "chat.history") {
        return { messages: [], thinkingLevel: null };
      }
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 0,
          defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
          sessions: [],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      chatMessage: "/model gpt-5-mini",
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "gpt-5-mini",
    });
    expect(host.chatModelOverrides.main).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
  });
});

describe("refreshChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("switches away from a missing direct session and reloads chat state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }) as unknown as typeof fetch,
    );
    const applySettings = vi.fn();
    const loadAssistantIdentity = vi.fn(async () => {});
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              text: `history:${String(params?.sessionKey)}`,
            },
          ],
          thinkingLevel: null,
        };
      }
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 1,
          defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
          sessions: [{ key: "main", kind: "direct", updatedAt: null }],
        };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:main:discord:channel:123",
      chatMessage: "draft",
      chatAttachments: [{ id: "a1", dataUrl: "data:image/png;base64,abc", mimeType: "image/png" }],
      chatQueue: [{ id: "q1", text: "queued", createdAt: 1 }],
      chatRunId: "run-1",
      chatStream: "stale",
      settings: {
        gatewayUrl: "",
        token: "",
        sessionKey: "agent:main:discord:channel:123",
        lastActiveSessionKey: "agent:main:discord:channel:123",
        theme: "claw",
        themeMode: "dark",
        chatFocusMode: false,
        chatShowThinking: true,
        chatShowToolCalls: true,
        splitRatio: 0.6,
        navCollapsed: false,
        navWidth: 280,
        navGroupsCollapsed: {},
      },
      applySettings,
      loadAssistantIdentity,
    });

    await refreshChat(host, { scheduleScroll: false });

    expect(host.sessionKey).toBe("main");
    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toEqual([]);
    expect(host.chatQueue).toEqual([]);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatMessages).toEqual([
      {
        role: "assistant",
        text: "history:main",
      },
    ]);
    expect(applySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "main",
        lastActiveSessionKey: "main",
      }),
    );
    expect(loadAssistantIdentity).toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(1, "chat.history", {
      sessionKey: "agent:main:discord:channel:123",
      limit: 200,
    });
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "main",
      limit: 200,
    });
  });

  it("uses a fresh sessions snapshot before falling back when sessions are already loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }) as unknown as typeof fetch,
    );
    const applySettings = vi.fn();
    const loadAssistantIdentity = vi.fn(async () => {});
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              text: `history:${String(params?.sessionKey)}`,
            },
          ],
          thinkingLevel: null,
        };
      }
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 1,
          defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
          sessions: [
            { key: "agent:main:discord:channel:123", kind: "direct", updatedAt: null },
            { key: "main", kind: "direct", updatedAt: null },
          ],
        };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:main:discord:channel:123",
      chatMessage: "draft",
      settings: {
        gatewayUrl: "",
        token: "",
        sessionKey: "agent:main:discord:channel:123",
        lastActiveSessionKey: "agent:main:discord:channel:123",
        theme: "claw",
        themeMode: "dark",
        chatFocusMode: false,
        chatShowThinking: true,
        chatShowToolCalls: true,
        splitRatio: 0.6,
        navCollapsed: false,
        navWidth: 280,
        navGroupsCollapsed: {},
      },
      applySettings,
      loadAssistantIdentity,
    }) as ChatHost & {
      sessionsLoading: boolean;
      sessionsResult: unknown;
      chatSessionsResult?: unknown;
    };
    host.sessionsLoading = true;
    host.sessionsResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [{ key: "main", kind: "direct", updatedAt: null }],
    };

    await refreshChat(host, { scheduleScroll: false });

    expect(host.sessionKey).toBe("agent:main:discord:channel:123");
    expect(host.chatMessage).toBe("draft");
    expect(host.chatMessages).toEqual([
      {
        role: "assistant",
        text: "history:agent:main:discord:channel:123",
      },
    ]);
    expect(host.sessionsResult).toEqual({
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        { key: "agent:main:discord:channel:123", kind: "direct", updatedAt: null },
        { key: "main", kind: "direct", updatedAt: null },
      ],
    });
    expect(host.chatSessionsResult).toEqual(host.sessionsResult);
    expect(applySettings).not.toHaveBeenCalled();
    expect(loadAssistantIdentity).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
  });
});
