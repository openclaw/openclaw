import { nothing, render } from "lit";
/* @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { setCurrentThemeBranding } from "../app/theme-branding.ts";
import { renderChatAvatar, renderForwardedAvatar } from "../pages/chat/chat-avatar.ts";
import * as artworkLoader from "../pages/plugins/icon-loader.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";

const pageLoadRandom = vi.hoisted(() => vi.spyOn(Math, "random").mockReturnValue(0));

beforeAll(() => pageLoadRandom.mockRestore());

afterEach(() => {
  setCurrentThemeBranding(resolveThemeBranding({ mascot: "claw", critters: [] }));
});

const branding: ThemeBranding = resolveThemeBranding({
  mascot: "none",
  critters: [],
  avatarHat: "fedora",
});

describe("theme avatar hats", () => {
  it.each(["agent-5", "agent-0"])(
    "applies the theme hat to loaded transcript and forwarded photos for %s",
    (agentId) => {
      setCurrentThemeBranding(branding);
      const container = document.createElement("div");
      const avatar = "data:image/png;base64,YQ==";
      for (const view of [
        renderChatAvatar("assistant", { agentId, name: "Scout", avatar }),
        renderForwardedAvatar(agentId, {
          agents: [{ id: agentId }],
          senderAgentAvatars: new Map([[agentId, avatar]]),
        }),
      ]) {
        render(view, container);
        const image = container.querySelector("img")!;
        image.dispatchEvent(new Event("load"));
        const hat = image.parentElement?.querySelector(":scope > .identity-avatar__hat");
        expect(Boolean(hat)).toBe(agentId === "agent-5");
        if (hat) {
          expect(hat.parentElement).toBe(image.parentElement);
          expect(hat.parentElement?.getAttribute("data-avatar-state")).toBe("loaded");
        }
        render(nothing, container);
      }
    },
  );

  it.each([
    ["fedora", "agent-5", false, "none", true],
    ["fedora", "agent-5", false, "claw", true],
    ["fedora", "agent-0", false, "none", false],
    ["fedora", "agent-5", true, "none", false],
    ["fedora", "openclaw", false, "none", false],
    ["fedora", "crestodian", false, "claw", false],
  ] as const)(
    "renders %s for %s (pending=%s, mascot=%s, hat=%s)",
    (avatarHat, id, pending, mascot, hat) => {
      setCurrentThemeBranding(resolveThemeBranding({ ...branding, avatarHat, mascot }));
      const container = document.createElement("div");
      const agent = { id, pending, textAvatar: "🦀" };
      render(renderAgentIdentityAvatar(agent), container);
      const overlay = container.querySelector(".identity-avatar--agent > .identity-avatar__hat");
      expect(Boolean(overlay)).toBe(hat);
      if (hat) {
        expect(overlay?.classList.contains(`identity-avatar__hat--${avatarHat}`)).toBe(true);
        expect(overlay?.getAttribute("aria-hidden")).toBe("true");
        expect(overlay?.querySelector(".identity-avatar__hat-svg")?.namespaceURI).toBe(
          "http://www.w3.org/2000/svg",
        );
      }
      setCurrentThemeBranding(resolveThemeBranding({ mascot: "claw", critters: [] }));
      render(renderAgentIdentityAvatar(agent), container);
      expect(container.querySelector(".identity-avatar__hat")).toBeNull();
      render(nothing, container);
    },
  );
});

it.each([false, true])(
  "renders a plugin hat on the shared and chat photo avatar (missing=%s)",
  async (missing) => {
    const fetchArtwork = vi
      .spyOn(artworkLoader, "fetchPluginThemeArtworkBlobUrl")
      .mockImplementation(async ({ url }) => (url.includes("missing") ? null : "blob:beret"));
    onTestFinished(() => fetchArtwork.mockRestore());
    setCurrentThemeBranding(
      resolveThemeBranding({
        mascot: "claw",
        critters: [],
        avatarHat: "beret",
        artwork: { hats: { beret: { url: missing ? "/missing" : "/beret" } } },
      }),
    );
    const container = document.createElement("div");
    render(renderAgentIdentityAvatar({ id: "agent-5", textAvatar: "🦀" }), container);
    expect(container.querySelector(".identity-avatar__hat-img")).toBeNull();
    await vi.dynamicImportSettled();
    expect(container.querySelector(".identity-avatar__hat-img")?.getAttribute("src") ?? null).toBe(
      missing ? null : "blob:beret",
    );
    expect(container.querySelector(".identity-avatar__hat svg")).toBeNull();
    render(
      renderChatAvatar("assistant", { agentId: "agent-5", name: "Scout", avatar: "blob:photo" }),
      container,
    );
    await vi.dynamicImportSettled();
    expect(
      container
        .querySelector(".chat-avatar-slot > .identity-avatar__hat img")
        ?.getAttribute("src") ?? null,
    ).toBe(missing ? null : "blob:beret");
    render(nothing, container);
  },
);
