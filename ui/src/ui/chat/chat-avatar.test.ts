/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderChatAvatar } from "./chat-avatar.ts";

vi.mock("../views/agents-utils.ts", () => {
  const isRenderableControlUiAvatarUrl = (value: string) =>
    /^data:image\//i.test(value) || (value.startsWith("/") && !value.startsWith("//"));

  return {
    assistantAvatarFallbackUrl: () => "/openclaw-molty.png",
    isRenderableControlUiAvatarUrl,
    resolveAssistantTextAvatar: (value: string | null | undefined) => {
      const trimmed = value?.trim();
      if (!trimmed || trimmed === "A") {
        return null;
      }
      if (trimmed.startsWith("blob:") || isRenderableControlUiAvatarUrl(trimmed)) {
        return null;
      }
      if (
        trimmed.length > 8 ||
        /\s/.test(trimmed) ||
        /[\\/.:]/.test(trimmed) ||
        /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(trimmed)
      ) {
        return null;
      }
      return trimmed;
    },
    resolveChatAvatarRenderUrl: (
      candidate: string | null | undefined,
      agent: { identity?: { avatar?: string; avatarUrl?: string } },
    ) => {
      if (typeof candidate === "string" && candidate.startsWith("blob:")) {
        return candidate;
      }
      for (const value of [candidate, agent.identity?.avatarUrl, agent.identity?.avatar]) {
        if (typeof value === "string" && isRenderableControlUiAvatarUrl(value)) {
          return value;
        }
      }
      return null;
    },
  };
});

function renderAvatar(params: Parameters<typeof renderChatAvatar>) {
  const container = document.createElement("div");
  render(renderChatAvatar(...params), container);
  return container.querySelector<HTMLElement>(".chat-avatar");
}

describe("renderChatAvatar", () => {
  it("uses the assistant fallback when no assistant avatar is configured", () => {
    const avatar = renderAvatar(["assistant"]);

    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("src")).toBe("/openclaw-molty.png");
  });

  it("renders assistant fallback, blob image, and text avatars", () => {
    const remoteAvatar = renderAvatar([
      "assistant",
      { avatar: "https://example.com/avatar.png", name: "Val" },
    ]);
    expect(remoteAvatar?.getAttribute("src")).toBe("/openclaw-molty.png");

    const blobAvatar = renderAvatar(["assistant", { avatar: "blob:managed-image", name: "Val" }]);
    expect(blobAvatar?.tagName).toBe("IMG");
    expect(blobAvatar?.getAttribute("src")).toBe("blob:managed-image");

    const textAvatar = renderAvatar(["assistant", { avatar: "VC", name: "Val" }]);
    expect(textAvatar?.tagName).toBe("DIV");
    expect(textAvatar?.textContent).toContain("VC");
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

    expect(avatar?.getAttribute("src")).toBe("/openclaw-molty.png");
  });

  it("renders local user image and text avatars", () => {
    const imageAvatar = renderAvatar(["user", undefined, { name: "Buns", avatar: "/avatar/user" }]);
    expect(imageAvatar?.getAttribute("src")).toBe("/avatar/user");
    expect(imageAvatar?.getAttribute("alt")).toBe("Buns");

    const textAvatar = renderAvatar(["user", undefined, { name: "Buns", avatar: "AB" }]);
    expect(textAvatar?.tagName).toBe("DIV");
    expect(textAvatar?.textContent).toContain("AB");
  });
});
