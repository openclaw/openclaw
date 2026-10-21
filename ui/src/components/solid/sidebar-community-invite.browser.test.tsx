import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import { SidebarCommunityInvite } from "./sidebar-community-invite.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("offers safe community links and dismisses permanently with the keyboard", async () => {
  const dismissed = vi.fn();
  const view = render(() => <SidebarCommunityInvite onDismiss={dismissed} />);
  const close = page.getByRole("button", { name: "Dismiss and don't show again" });
  const links = [...view.container.querySelectorAll<HTMLAnchorElement>(".sidebar-community__link")];
  expect(links.map((link) => [link.getAttribute("aria-label"), link.href])).toEqual([
    ["Join the OpenClaw community on Discord", "https://discord.gg/clawd"],
    ["Join the OpenClaw community on Reddit", "https://www.reddit.com/r/openclaw/"],
    ["Follow OpenClaw on X", "https://x.com/openclaw"],
  ]);
  for (const link of links) {
    expect(link.target).toBe("_blank");
    expect(link.rel.split(/\s+/u)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  }
  close.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(close).not.toBeInTheDocument();
  expect(dismissed).toHaveBeenCalledOnce();
  view.unmount();
  const remounted = render(() => <SidebarCommunityInvite onDismiss={dismissed} />);
  expect(remounted.container.querySelector(".community-invite-card")).toBeNull();
});
