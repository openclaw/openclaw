/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshChatAvatar, renderChatAvatar } from "./chat-avatar.ts";

vi.unmock("../../lib/agents/display.ts");

function renderAvatar(params: Parameters<typeof renderChatAvatar>) {
  const container = document.createElement("div");
  render(renderChatAvatar(...params), container);
  return container.querySelector<HTMLElement>(".chat-avatar");
}

describe("renderChatAvatar", () => {
  it("renders assistant fallback, blob image, and text avatars", () => {
    const defaultAvatar = renderAvatar(["assistant"]);
    expect(defaultAvatar?.getAttribute("src")).toBe("/apple-touch-icon.png");

    const remoteAvatar = renderAvatar([
      "assistant",
      { avatar: "https://example.com/avatar.png", name: "Val" },
    ]);
    expect(remoteAvatar?.getAttribute("src")).toBe("/apple-touch-icon.png");

    const blobAvatar = renderAvatar(["assistant", { avatar: "blob:managed-image", name: "Val" }]);
    expect(blobAvatar?.tagName).toBe("IMG");
    expect(blobAvatar?.getAttribute("src")).toBe("blob:managed-image");

    const textAvatar = renderAvatar(["assistant", { avatar: "VC", name: "Val" }]);
    expect(textAvatar?.tagName).toBe("DIV");
    expect(textAvatar?.textContent?.trim()).toBe("VC");
    expect(textAvatar?.getAttribute("aria-label")).toBe("Val");
  });

  it("uses the assistant fallback while authenticated avatar routes are loading", () => {
    const avatar = renderAvatar([
      "assistant",
      { avatar: "/avatar/main", name: "OpenClaw" },
      undefined,
      "",
      "session-token",
    ]);

    expect(avatar?.getAttribute("src")).toBe("/apple-touch-icon.png");
  });

  it("renders local user image and text avatars", () => {
    const imageAvatar = renderAvatar(["user", undefined, { name: "Buns", avatar: "/avatar/user" }]);
    expect(imageAvatar?.getAttribute("src")).toBe("/avatar/user");
    expect(imageAvatar?.getAttribute("alt")).toBe("Buns");

    const textAvatar = renderAvatar(["user", undefined, { name: "Buns", avatar: "AB" }]);
    expect(textAvatar?.tagName).toBe("DIV");
    expect(textAvatar?.textContent?.trim()).toBe("AB");
  });
});

describe("refreshChatAvatar error handling", () => {
  function createMockHost(
    overrides?: Partial<Parameters<typeof refreshChatAvatar>[0]>,
  ): Parameters<typeof refreshChatAvatar>[0] {
    return {
      connected: true,
      basePath: "",
      sessionKey: "agent:main:web:g1",
      hello: null,
      chatAvatarUrl: null,
      chatAvatarSource: null,
      chatAvatarStatus: null,
      chatAvatarReason: null,
      password: "test-pw",
      ...overrides,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears avatar state on fetch timeout (catch block handles TimeoutError)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));
    const host = createMockHost();
    host.chatAvatarSource = "previous";
    host.chatAvatarStatus = "remote";

    await refreshChatAvatar(host);

    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarSource).toBeNull();
    expect(host.chatAvatarStatus).toBeNull();
  });

  it("clears avatar state on generic fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network failure"));
    const host = createMockHost();
    host.chatAvatarUrl = "http://stale";
    host.chatAvatarSource = "previous";

    await refreshChatAvatar(host);

    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarSource).toBeNull();
  });

  it("skips fetch when disconnected", async () => {
    globalThis.fetch = vi.fn();
    const host = createMockHost({ connected: false });

    await refreshChatAvatar(host);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarSource).toBeNull();
  });
});
