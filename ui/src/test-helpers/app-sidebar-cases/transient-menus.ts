import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { activateSessionMenuValue } from "../app-sidebar-menu.ts";
import { selectSidebarView } from "../app-sidebar-setup.ts";
import { createGateway, createSessions, mountSidebar, TWO_AGENTS } from "../app-sidebar.ts";
import "../../components/app-sidebar.tsx";

async function mountMenus(keys = ["agent:main:main"], agents?: typeof TWO_AGENTS) {
  return mountSidebar(
    createGateway({} as GatewayBrowserClient),
    createSessions("main", keys),
    "panel",
    agents,
  );
}
type Sidebar = Awaited<ReturnType<typeof mountSidebar>>["sidebar"];
async function clickAndSettle(sidebar: Sidebar, element: HTMLElement) {
  element.click();
  await sidebar.updateComplete;
}
async function staleHide(sidebar: Sidebar, menu: HTMLElement | null) {
  menu?.dispatchEvent(new CustomEvent("overlay-after-hide", { bubbles: true, composed: true }));
  await sidebar.updateComplete;
}

describe("AppSidebar transient menus", () => {
  it("keeps the session filters open after a choice and closes from the trigger", async () => {
    const { sidebar } = await mountMenus(["agent:main:main", "agent:main:task"]);
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")!;

    await clickAndSettle(sidebar, trigger);
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu");
    expect(firstMenu).not.toBeNull();
    await activateSessionMenuValue(sidebar, "sort:updated");
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(firstMenu);
    await clickAndSettle(sidebar, trigger);
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBeNull();
  });

  it("ignores a stale agent-menu hide after opening its replacement", async () => {
    const { sidebar } = await mountMenus(undefined, TWO_AGENTS);
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!;

    await clickAndSettle(sidebar, trigger);
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    const settingsItem = firstMenu?.querySelector<HTMLElement>(
      '[data-value="command:agent-settings"]',
    );
    expect(firstMenu).not.toBeNull();
    expect(firstMenu?.closest("openclaw-menu-surface")).toBeNull();
    expect(settingsItem).not.toBeNull();
    await clickAndSettle(sidebar, settingsItem!);

    await clickAndSettle(sidebar, trigger);
    const replacement = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    expect(replacement).not.toBe(firstMenu);

    await staleHide(sidebar, firstMenu);
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBe(replacement);
  });

  async function openPinMenu(sidebar: Sidebar, entry: string) {
    const pin = sidebar.querySelector<HTMLElement>(
      `.sidebar-rail [data-sidebar-entry="${entry}"]`,
    )!;
    expect(pin).not.toBeNull();
    pin.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }),
    );
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-rail-pin-menu")!;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.closest("openclaw-menu-surface")).toBeNull();
    return menu;
  }

  it("ignores a removed pin menu's stale hide after Pages recreates that shortcut", async () => {
    const { sidebar } = await mountMenus();
    sidebar.sidebarEntries = ["route:usage"];
    const update = vi.fn((entries: string[]) => {
      sidebar.sidebarEntries = entries;
    });
    sidebar.onUpdateSidebarEntries = update;
    await sidebar.updateComplete;
    const first = await openPinMenu(sidebar, "route:usage");
    await clickAndSettle(sidebar, first.querySelector<HTMLElement>('[data-value="remove"]')!);
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
    await staleHide(sidebar, first);
    expect(replacement.isConnected).toBe(true);
    expect(replacement.getAttribute("role")).toBe("menu");
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    expect(update).toHaveBeenCalledTimes(writes);
  });

  it("keeps a second pin's menu and target independent of an earlier menu's hide", async () => {
    const { sidebar } = await mountMenus();
    sidebar.sidebarEntries = ["route:usage", "route:plugins"];
    sidebar.onUpdateSidebarEntries = (entries) => {
      sidebar.sidebarEntries = entries;
    };
    await sidebar.updateComplete;
    const first = await openPinMenu(sidebar, "route:usage");
    const replacement = await openPinMenu(sidebar, "route:plugins");
    expect(replacement).not.toBe(first);
    await staleHide(sidebar, first);
    expect(replacement.getAttribute("role")).toBe("menu");
    await clickAndSettle(sidebar, replacement.querySelector<HTMLElement>('[data-value="remove"]')!);
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    expect(sidebar.querySelector('.sidebar-rail [data-sidebar-entry="route:plugins"]')).toBeNull();
    expect(
      sidebar.querySelector('.sidebar-rail [data-sidebar-entry="route:usage"]'),
    ).not.toBeNull();
  });
});
