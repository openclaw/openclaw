/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSendChat, refreshChatAvatar, type ChatHost } from "./app-chat.ts";
import { sendChatMessage } from "./controllers/chat.ts";
import { saveSettings, type UiSettings } from "./storage.ts";

vi.mock("./controllers/chat.ts", () => ({
  abortChatRun: vi.fn(),
  loadChatHistory: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock("./storage.ts", async () => {
  const actual = await vi.importActual<typeof import("./storage.ts")>("./storage.ts");
  return {
    ...actual,
    saveSettings: vi.fn(),
  };
});

vi.mock("./app-scroll.ts", async () => {
  const actual = await vi.importActual<typeof import("./app-scroll.ts")>("./app-scroll.ts");
  return {
    ...actual,
    resetChatScroll: vi.fn(),
    scheduleChatScroll: vi.fn(),
  };
});

vi.mock("./app-tool-stream.ts", async () => {
  const actual =
    await vi.importActual<typeof import("./app-tool-stream.ts")>("./app-tool-stream.ts");
  return {
    ...actual,
    resetToolStream: vi.fn(),
  };
});

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
    vi.clearAllMocks();
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

  it("persists the last active session key without depending on app-settings", async () => {
    vi.mocked(sendChatMessage).mockResolvedValueOnce("run-1");

    const settings: UiSettings = {
      gatewayUrl: "ws://localhost:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
    };
    const host = Object.assign(
      makeHost({
        chatMessage: "hello",
        sessionKey: "agent:ops:main",
      }),
      {
        applySessionKey: "main",
        settings,
      },
    ) as ChatHost & { applySessionKey: string; settings: UiSettings };

    await handleSendChat(host);

    expect(vi.mocked(sendChatMessage)).toHaveBeenCalledWith(
      host as unknown as Parameters<typeof sendChatMessage>[0],
      "hello",
      undefined,
    );
    expect(host.settings.lastActiveSessionKey).toBe("agent:ops:main");
    expect(host.applySessionKey).toBe("agent:ops:main");
    expect(vi.mocked(saveSettings)).toHaveBeenCalledWith(
      expect.objectContaining({ lastActiveSessionKey: "agent:ops:main" }),
    );
  });
});
