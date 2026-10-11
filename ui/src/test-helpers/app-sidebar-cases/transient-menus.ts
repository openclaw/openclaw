import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { activateSessionMenuValue } from "../app-sidebar-menu.ts";
import { selectSidebarView } from "../app-sidebar-setup.ts";
import { createGateway, createSessions, mountSidebar, TWO_AGENTS } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar transient menus", () => {
  it("keeps the session filters open after a choice and closes from the trigger", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", "agent:main:task"]),
    );
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort");
    if (!trigger) {
      throw new Error("expected sort menu trigger");
    }

    trigger.click();
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu");
    expect(firstMenu).not.toBeNull();
    await activateSessionMenuValue(sidebar, "sort:updated");
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(firstMenu);
    trigger.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBeNull();
  });

  it("ignores a stale agent-menu hide after opening its replacement", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main");
    if (!trigger) {
      throw new Error("expected agent menu trigger");
    }

    trigger.click();
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    const settingsItem = firstMenu?.querySelector<HTMLElement>(
      'wa-dropdown-item[value="command:agent-settings"]',
    );
    expect(firstMenu).not.toBeNull();
    expect(firstMenu?.closest("openclaw-menu-surface")).toBeNull();
    expect(settingsItem).not.toBeNull();
    firstMenu?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: settingsItem },
      }),
    );
    await sidebar.updateComplete;

    trigger.click();
    await sidebar.updateComplete;
    const replacement = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    expect(replacement).not.toBe(firstMenu);

    firstMenu?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBe(replacement);
  });

  async function openPinMenu(
    sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"],
    entry: string,
  ) {
    const pin = sidebar.querySelector<HTMLElement>(
      `.sidebar-rail [data-sidebar-entry="${entry}"]`,
    )!;
    expect(pin).not.toBeNull();
    const trigger = pin.querySelector<HTMLButtonElement>("button[slot=trigger]")!;
    expect(trigger.getAttribute("aria-label")).toContain("Reorder");
    const menu = pin.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<boolean> }
    >("wa-dropdown")!;
    // The dropdown owns trigger interaction; these jsdom cases exercise its public
    // open state and the renderer's stale-hide/target boundaries, not popup geometry.
    menu.open = true;
    await menu.updateComplete;
    expect(menu.open).toBe(true);
    expect(menu.closest("openclaw-menu-surface")).toBeNull();
    return menu;
  }

  it("ignores a removed pin menu's stale hide after Pages recreates that shortcut", async () => {
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.sidebarEntries = ["route:usage"];
    const update = vi.fn((entries: string[]) => {
      sidebar.sidebarEntries = entries;
    });
    sidebar.onUpdateSidebarEntries = update;
    await sidebar.updateComplete;
    const first = await openPinMenu(sidebar, "route:usage");
    first.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "remove" } } }));
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual([]);
    expect(first.isConnected).toBe(false);
    await selectSidebarView(sidebar, "pages");
    const page = sidebar.querySelector('.sidebar-pages [data-sidebar-entry="route:usage"]')!;
    page
      .closest(".sidebar-pages__entry")!
      .querySelector<HTMLButtonElement>('[aria-label="Pin"]')!
      .click();
    await sidebar.updateComplete;
    const replacement = await openPinMenu(sidebar, "route:usage");
    expect(replacement).not.toBe(first);
    const writes = update.mock.calls.length;
    first.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(replacement.isConnected).toBe(true);
    expect(replacement.open).toBe(true);
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    expect(update).toHaveBeenCalledTimes(writes);
  });

  it("keeps a second pin's menu and target independent of an earlier menu's hide", async () => {
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.sidebarEntries = ["route:usage", "route:plugins"];
    sidebar.onUpdateSidebarEntries = (entries) => {
      sidebar.sidebarEntries = entries;
    };
    await sidebar.updateComplete;
    const first = await openPinMenu(sidebar, "route:usage");
    const replacement = await openPinMenu(sidebar, "route:plugins");
    expect(replacement).not.toBe(first);
    first.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(replacement.open).toBe(true);
    replacement.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: { value: "remove" } } }),
    );
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    expect(sidebar.querySelector('.sidebar-rail [data-sidebar-entry="route:plugins"]')).toBeNull();
    expect(
      sidebar.querySelector('.sidebar-rail [data-sidebar-entry="route:usage"]'),
    ).not.toBeNull();
  });
});
