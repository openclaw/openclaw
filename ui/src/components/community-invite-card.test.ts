/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCommunityInviteCard } from "./community-invite-card.ts";
import { COMMUNITY_INVITE_KEY } from "./community-invite-state.ts";

const onDismiss = vi.fn<() => void>();
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  onDismiss.mockReset();
  document.body.append(container);
  render(renderCommunityInviteCard(onDismiss, "dark"), container);
});

afterEach(() => {
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

function cardQuery(selector: string): HTMLElement {
  const found = container.querySelector(selector);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`missing ${selector}`);
  }
  return found;
}

describe("community invite card", () => {
  it("is a non-modal complementary region, not a dialog", () => {
    const region = cardQuery("aside.invite");
    expect(region.getAttribute("role")).toBe("complementary");
    // A focus trap or an aria-modal here would make it interrupt the operator.
    expect(region.getAttribute("aria-modal")).toBeNull();
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(container.querySelector("[autofocus]")).toBeNull();
  });

  it("delegates dismissal from the close button", () => {
    const close = cardQuery(".invite__close");
    expect(close.getAttribute("aria-label")).toBe("Dismiss and don't show again");
    close.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(localStorage.getItem(COMMUNITY_INVITE_KEY)).toBeNull();
  });

  it("opens each community destination without dismissing the invitation", () => {
    const links = [...container.querySelectorAll<HTMLAnchorElement>(".invite__cta")];
    expect(
      links.map((link) => [link.textContent?.trim(), link.getAttribute("aria-label"), link.href]),
    ).toEqual([
      ["Join", "Join the OpenClaw community on Reddit", "https://www.reddit.com/r/openclaw/"],
      ["Join", "Join the OpenClaw community on Discord", "https://discord.gg/clawd"],
      ["Follow", "Follow OpenClaw on X", "https://x.com/openclaw"],
    ]);
    for (const link of links) {
      expect(link.target).toBe("_blank");
      expect(link.title).toBe(link.getAttribute("aria-label"));
      expect(link.rel.split(/\s+/u)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
      link.click();
    }
    expect(onDismiss).not.toHaveBeenCalled();
    expect(localStorage.getItem(COMMUNITY_INVITE_KEY)).toBeNull();
    expect(cardQuery(".community-invite-card").isConnected).toBe(true);
  });
});
