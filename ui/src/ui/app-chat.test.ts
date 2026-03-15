/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushChatQueueForEvent,
  handleSendChat,
  refreshChatAvatar,
  type ChatHost,
} from "./app-chat.ts";
import type { ChatAutoScrollMode } from "./app-scroll.ts";

type TestChatHost = ChatHost & {
  chatUserNearBottom: boolean;
  chatAutoScrollMode: ChatAutoScrollMode;
  chatSuppressedBlockId: string | null;
  chatNewMessagesBelow: boolean;
  chatToolMessages: unknown[];
  chatStreamSegments: Array<{ text: string; ts: number }>;
  toolStreamById: Map<string, unknown>;
  toolStreamOrder: string[];
  toolStreamSyncTimer: number | null;
  querySelector: (selector: string) => Element | null;
  style: CSSStyleDeclaration;
  chatScrollFrame: number | null;
  chatScrollTimeout: number | null;
  chatHasAutoScrolled: boolean;
  settings: { lastActiveSessionKey: string };
};

function makeHost(overrides?: Partial<TestChatHost>): TestChatHost {
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
    chatUserNearBottom: true,
    chatAutoScrollMode: "bottom",
    chatSuppressedBlockId: null,
    chatNewMessagesBelow: false,
    chatToolMessages: [],
    chatStreamSegments: [],
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    querySelector: () => null,
    style: {} as CSSStyleDeclaration,
    chatScrollFrame: null,
    chatScrollTimeout: null,
    chatHasAutoScrolled: false,
    lastError: null,
    settings: {
      lastActiveSessionKey: "agent:main",
    },
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

  it("re-arms bottom-follow when sending a new message", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "hello",
      chatUserNearBottom: false,
      chatAutoScrollMode: "clamp",
      chatSuppressedBlockId: "stream:1",
      chatNewMessagesBelow: true,
    });

    await handleSendChat(host);

    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatAutoScrollMode).toBe("bottom");
    expect(host.chatSuppressedBlockId).toBeNull();
    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("preserves manual scroll state when draining a queued send", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "queued hello",
      chatSending: true,
      chatUserNearBottom: false,
      chatAutoScrollMode: "clamp",
      chatSuppressedBlockId: "stream:1",
      chatNewMessagesBelow: true,
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatUserNearBottom).toBe(false);
    expect(host.chatAutoScrollMode).toBe("clamp");
    expect(host.chatSuppressedBlockId).toBe("stream:1");
    expect(host.chatNewMessagesBelow).toBe(true);

    host.chatSending = false;
    await flushChatQueueForEvent(host);

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ message: "queued hello" }),
    );
    expect(host.chatQueue).toHaveLength(0);
    expect(host.chatUserNearBottom).toBe(false);
    expect(host.chatAutoScrollMode).toBe("clamp");
    expect(host.chatSuppressedBlockId).toBe("stream:1");
    expect(host.chatNewMessagesBelow).toBe(true);
  });
});
