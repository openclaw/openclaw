/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshChatAvatar, type ChatHost } from "./app-chat.ts";

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
    refreshSessionsAfterChat: new Set<string>(),
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

  it("fetches relative avatar path with device token and stores blob URL", async () => {
    const imageBlob = new Blob(["fake-image"], { type: "image/jpeg" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ avatarUrl: "/avatar/main" }),
      })
      .mockResolvedValueOnce({ ok: true, blob: async () => imageBlob });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn().mockReturnValue("blob:mock-url"),
    });

    const host = makeHost({
      basePath: "",
      sessionKey: "agent:main",
      hello: { auth: { deviceToken: "test-token" } } as ChatHost["hello"],
    });
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/avatar/main",
      expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
    );
    expect(host.chatAvatarUrl).toBe("blob:mock-url");
  });
});
