/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSendChat, refreshChatAvatar, type ChatHost } from "./app-chat.ts";
import type { UiSettings } from "./storage.ts";

type TestChatHost = ChatHost & {
  chatToolMessages: unknown[];
  chatStreamSegments: Array<{ text: string; ts: number }>;
  toolStreamById: Map<string, unknown>;
  toolStreamOrder: string[];
  toolStreamSyncTimer: number | null;
  settings: UiSettings;
  theme: "claw";
  themeMode: "dark";
  themeResolved: "dark";
  applySessionKey: string;
};

function makeHost(overrides?: Partial<TestChatHost>): TestChatHost {
  return {
    client: null,
    chatMessages: [],
    chatToolMessages: [],
    chatStreamSegments: [],
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
    toolStreamById: new Map<string, unknown>(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    settings: {
      gatewayUrl: "",
      token: "",
      sessionKey: "agent:main",
      lastActiveSessionKey: "agent:main",
      theme: "claw",
      themeMode: "dark",
      chatFocusMode: false,
      chatShowThinking: false,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 280,
      navGroupsCollapsed: {},
    },
    theme: "claw",
    themeMode: "dark",
    themeResolved: "dark",
    applySessionKey: "agent:main",
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

  it("cancels button-triggered new sessions when the user declines confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const request = vi.fn();
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "keep this draft",
    });

    await handleSendChat(host, "/new", { confirmReset: true, restoreDraft: true });

    expect(confirmSpy).toHaveBeenCalledWith(
      "Start a new session?\n\nUnsaved context in the current session will be lost.",
    );
    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("keep this draft");
    expect(host.chatMessages).toEqual([]);
  });

  it("sends button-triggered new sessions when the user accepts confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const request = vi.fn().mockResolvedValue({ ok: true });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "keep this draft",
    });

    await handleSendChat(host, "/new", { confirmReset: true, restoreDraft: true });

    expect(confirmSpy).toHaveBeenCalledWith(
      "Start a new session?\n\nUnsaved context in the current session will be lost.",
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main",
        message: "/new",
        deliver: false,
      }),
    );
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
        return { ok: true, key: "main" };
      }
      if (method === "chat.history") {
        return { messages: [], thinkingLevel: null };
      }
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 0,
          defaults: { model: "gpt-5", contextTokens: null },
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
    expect(host.chatModelOverrides.main).toBe("gpt-5-mini");
  });
});
