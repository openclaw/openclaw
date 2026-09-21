/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
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
    expect([...agentIds].reverse().map((id) => resolveAvatarHat(id, branding))).toEqual([
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
