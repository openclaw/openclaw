/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { renderChatAvatar, renderForwardedAvatar } from "../pages/chat/chat-avatar.ts";
import { resolveAvatarHat } from "./agent-avatar-hat.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";

const pageLoadRandom = vi.hoisted(() => vi.spyOn(Math, "random").mockReturnValue(0));

beforeAll(() => pageLoadRandom.mockRestore());

afterEach(() => {
  delete document.documentElement.dataset.themeAvatarHat;
  delete document.documentElement.dataset.themeMascot;
});

const branding: ThemeBranding = { mascot: "none", critters: [], avatarHat: "fedora" };

describe("theme avatar hats", () => {
  it("keeps one of six fixed agent seeds selected across render order within a page load", () => {
    const agentIds = ["agent-0", "agent-1", "agent-2", "agent-3", "agent-4", "agent-5"];
    expect(agentIds.map((id) => resolveAvatarHat(id, branding))).toEqual([
      null,
      null,
      null,
      null,
      null,
      "fedora",
    ]);
    expect(agentIds.toReversed().map((id) => resolveAvatarHat(id, branding))).toEqual([
      "fedora",
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("requires theme opt-in and excludes reserved system agents", () => {
    expect(resolveAvatarHat("agent-5", { mascot: "claw" })).toBeNull();
    expect(resolveAvatarHat("openclaw", branding)).toBeNull();
    expect(resolveAvatarHat("crestodian", branding)).toBeNull();
  });

  it.each(["agent-5", "agent-0"])(
    "applies the theme hat to loaded transcript and forwarded photos for %s",
    (agentId) => {
      document.documentElement.dataset.themeAvatarHat = "fedora";
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
    { id: "agent-5", pending: false, mascot: "none", hat: true },
    { id: "agent-5", pending: false, mascot: "claw", hat: true },
    { id: "agent-0", pending: false, mascot: "none", hat: false },
    { id: "agent-5", pending: true, mascot: "none", hat: false },
    { id: "openclaw", pending: false, mascot: "none", hat: false },
    { id: "crestodian", pending: false, mascot: "claw", hat: false },
  ])(
    "renders the shared avatar for $id ($mascot, pending=$pending)",
    ({ id, pending, mascot, hat }) => {
      document.documentElement.dataset.themeAvatarHat = "fedora";
      document.documentElement.dataset.themeMascot = mascot;
      const container = document.createElement("div");
      const agent = { id, pending, textAvatar: "🦀" };
      render(renderAgentIdentityAvatar(agent), container);
      const overlay = container.querySelector(".identity-avatar--agent > .identity-avatar__hat");
      expect(Boolean(overlay)).toBe(hat);
      if (hat) {
        expect(overlay?.classList.contains("identity-avatar__hat--fedora")).toBe(true);
        expect(overlay?.getAttribute("aria-hidden")).toBe("true");
        expect(overlay?.querySelector("svg")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
      }
      delete document.documentElement.dataset.themeAvatarHat;
      render(renderAgentIdentityAvatar(agent), container);
      expect(container.querySelector(".identity-avatar__hat")).toBeNull();
      render(nothing, container);
    },
  );
});
