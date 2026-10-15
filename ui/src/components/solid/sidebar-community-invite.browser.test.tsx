import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import { SidebarCommunityInvite } from "./sidebar-community-invite.tsx";

afterEach(cleanup);

it("opens Community only on request and returns focus without dismissing the entry", async () => {
  const view = render(() => <SidebarCommunityInvite />);
  const trigger = page.getByRole("button", { name: "Community", exact: true });
  expect(view.container.querySelector("dialog")).toBeNull();
  expect(view.container.querySelector("img")).toBeNull();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Community", exact: true });
  await expect.element(dialog).toBeVisible();
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
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
  expect(view.container.querySelector("dialog")).toBeNull();
  await trigger.click();
  await expect.element(dialog).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(trigger).toHaveFocus();
  expect(view.container.querySelector("dialog")).toBeNull();
});
