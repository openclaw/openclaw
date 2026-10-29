import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/load-styles.ts";
import { installTitleTooltips } from "./tooltip-title.ts";

let disposeTitleTooltips: () => void;
beforeEach(() => {
  disposeTitleTooltips = installTitleTooltips(document);
});
afterEach(() => {
  disposeTitleTooltips();
  document.body.replaceChildren();
});

describe.runIf("__vitest_browser__" in globalThis)("identity menu keyboard navigation", () => {
  it("traverses the actual item order and both footer controls in each direction", async () => {
    await import("./app-sidebar.tsx");
    const { createGatewayHarness, createSessions, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const { page, userEvent } = await import("vitest/browser");
    const { sidebar, context } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.connected = true;
    sidebar.canPairDevice = false;
    await sidebar.updateComplete;

    const identity = sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card");
    expect(identity).not.toBeNull();
    const tooltip = () =>
      document.querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>("body > openclaw-tooltip");
    // The retained rail is icon-only: pointer and keyboard users need its identity hint.
    await page.elementLocator(identity!).hover();
    expect(tooltip()?.anchor).toBe(identity);
    expect(tooltip()?.content).toContain("Identity and app menu for Owner");
    expect(identity?.getAttribute("title")).toBe("");
    expect(page.getByRole("button", { name: /Owner/ }).elements()).toContain(identity);
    expect(identity?.getAttribute("aria-expanded")).toBe("false");
    // A pointer left over the footer can open Help as the keyboard menu appears.
    await page.elementLocator(document.body).hover({ position: { x: 0, y: 0 } });
    identity?.focus();
    expect(tooltip()?.anchor).toBe(identity);
    expect(tooltip()?.content).toContain("Identity and app menu for Owner");
    await userEvent.keyboard("{Enter}");

    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].filter(
      (item) =>
        item.closest('[role="menu"]') === menu &&
        !item.hasAttribute("disabled") &&
        !item.closest(".sidebar-identity-menu__footer"),
    );
    const theme = menu?.querySelector<HTMLButtonElement>(".theme-mode-toggle");
    expect(theme?.getAttribute("role")).toBe("menuitem");
    const build = menu?.querySelector<HTMLAnchorElement>(".sidebar-footer-build");
    await expect.poll(() => document.activeElement).toBe(items[0]);
    // Navigation loads on first open; until then keys are queued and replayed later
    // (menu-navigation cold tests), so wait before asserting each step synchronously.
    await expect
      .poll(() => items[0]?.hasAttribute("data-highlighted"), { timeout: 5_000 })
      .toBe(true);
    expect(tooltip()).toBeNull();

    for (const expected of items.slice(1)) {
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(expected);
    }
    expect(items.at(-1)?.getAttribute("data-highlighted")).not.toBeNull();
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => document.activeElement?.closest('[role="menu"]')).not.toBe(menu);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.closest('[role="menu"]')).not.toBe(menu);
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => document.activeElement).toBe(items.at(-1));
    await userEvent.keyboard("{ArrowDown}");
    if (build) {
      expect(document.activeElement).toBe(build);
      await userEvent.keyboard("{ArrowDown}");
    }
    expect(document.activeElement).toBe(theme);
    await userEvent.keyboard("{ArrowUp}");
    if (build) {
      expect(document.activeElement).toBe(build);
      await userEvent.keyboard("{ArrowUp}");
    }
    expect(document.activeElement).toBe(items.at(-1));
    expect(items.at(-1)?.getAttribute("data-highlighted")).not.toBeNull();

    if (build) {
      await userEvent.keyboard("{ArrowDown}");
    }
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(theme);
    await userEvent.keyboard("{Enter}");
    expect(context.theme.mode).toBe("light");
    await userEvent.keyboard("{Tab}");
    await expect.poll(() => sidebar.querySelector(".sidebar-identity-menu")).toBeNull();
  });
});
