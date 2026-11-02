import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import "../../../public/themes/absolutely.css";
import "../../../public/themes/tide.css";
import { SidebarCommunityInvite } from "./sidebar-community-invite.tsx";

const root = document.documentElement;
const originalTheme = root.getAttribute("data-theme");
const originalMode = root.getAttribute("data-theme-mode");

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const [name, value] of [
    ["data-theme", originalTheme],
    ["data-theme-mode", originalMode],
  ] as const) {
    if (value === null) {
      root.removeAttribute(name);
    } else {
      root.setAttribute(name, value);
    }
  }
});

it("offers safe community links and dismisses permanently with the keyboard", async () => {
  const dismissed = vi.fn();
  const view = render(() => <SidebarCommunityInvite onDismiss={dismissed} mode="light" />);
  expect(view.container.querySelector(".invite__title")?.textContent).toBe("Pull up a chair.");
  const close = page.getByRole("button", { name: "Dismiss and don't show again" });
  const links = [...view.container.querySelectorAll<HTMLAnchorElement>(".invite__cta")];
  expect(links.map((link) => [link.getAttribute("aria-label"), link.href])).toEqual([
    ["Join the OpenClaw community on Reddit", "https://www.reddit.com/r/openclaw/"],
    ["Join the OpenClaw community on Discord", "https://discord.gg/clawd"],
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
  const remounted = render(() => <SidebarCommunityInvite onDismiss={dismissed} mode="light" />);
  expect(remounted.container.querySelector(".community-invite-card")).toBeNull();
});

it("uses the sidebar surface and matching artwork in light and dark themes", () => {
  for (const theme of ["claw", "absolutely", "tide"]) {
    for (const mode of ["light", "dark"] as const) {
      root.dataset.theme = theme === "claw" ? mode : theme + (mode === "light" ? "-light" : "");
      root.dataset.themeMode = mode;
      const view = render(() => (
        <div class="sidebar">
          <div class="sidebar-shell">
            <SidebarCommunityInvite onDismiss={() => {}} mode={mode} />
          </div>
        </div>
      ));
      const sidebar = view.container.querySelector<HTMLElement>(".sidebar")!;
      const invite = view.container.querySelector<HTMLElement>(".invite")!;
      expect(getComputedStyle(invite).backgroundColor).toBe(
        getComputedStyle(sidebar).backgroundColor,
      );
      expect(view.container.querySelector(".invite__art")?.getAttribute("src")).toContain(
        `community-invite-${mode}.webp`,
      );
      view.unmount();
    }
  }
});
