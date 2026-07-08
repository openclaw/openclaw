/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "./app-sidebar.ts";

type TestSidebar = HTMLElement & {
  canPairDevice: boolean;
  themeMode: "system" | "light" | "dark";
  updateComplete: Promise<boolean>;
};

function createSidebar(): TestSidebar {
  const Sidebar = customElements.get("openclaw-app-sidebar");
  if (!Sidebar) {
    throw new Error("openclaw-app-sidebar was not registered");
  }
  const sidebar = new Sidebar() as TestSidebar;
  sidebar.canPairDevice = true;
  document.body.append(sidebar);
  return sidebar;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("app sidebar footer", () => {
  it("keeps only More, Settings, and Mobile actions fixed in the footer", async () => {
    const sidebar = createSidebar();

    await sidebar.updateComplete;

    const footerActions = [
      ...sidebar.querySelectorAll<HTMLElement>(".sidebar-footer-bar .sidebar-footer-icon"),
    ];
    expect(footerActions.map((action) => action.getAttribute("aria-label"))).toEqual([
      "More",
      "Settings",
      "Pair mobile device",
    ]);
    expect(sidebar.querySelector(".sidebar-footer-bar a[href='https://docs.openclaw.ai']")).toBe(
      null,
    );
    expect(sidebar.querySelector("openclaw-theme-mode-toggle")).toBeNull();
  });

  it("moves docs and theme controls into the footer More menu", async () => {
    const sidebar = createSidebar();
    sidebar.themeMode = "dark";
    const themeChange = vi.fn();
    sidebar.addEventListener("theme-change", themeChange);
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-footer-more")?.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector<HTMLElement>(".sidebar-footer-menu");
    expect(menu?.querySelector("a[href='https://docs.openclaw.ai']")).not.toBeNull();
    expect(menu?.querySelector(".sidebar-session-menu__check")).toBeNull();
    const activeTheme = menu?.querySelector<HTMLElement>(
      ".sidebar-footer-theme-toggle__button[aria-pressed='true']",
    );
    expect(activeTheme?.getAttribute("aria-label")).toContain("Dark");
    expect(menu?.querySelector(".sidebar-footer-menu__action-icon svg")).not.toBeNull();

    const themeButtons = [
      ...(menu?.querySelectorAll<HTMLButtonElement>(".sidebar-footer-theme-toggle__button") ?? []),
    ];
    const lightOption = themeButtons.find((button) =>
      button.getAttribute("aria-label")?.includes("Light"),
    );
    expect(lightOption).toBeDefined();
    lightOption?.click();

    expect(themeChange).toHaveBeenCalledOnce();
    const event = themeChange.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail.mode).toBe("light");
  });
});
