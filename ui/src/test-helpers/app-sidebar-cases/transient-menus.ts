import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { activateSessionMenuValue } from "../app-sidebar-menu.ts";
import { selectSidebarView } from "../app-sidebar-setup.ts";
import { createGateway, createSessions, mountSidebar, TWO_AGENTS } from "../app-sidebar.ts";
import "../../components/app-sidebar.tsx";

async function mountMenus(keys = ["agent:main:main"], agents?: typeof TWO_AGENTS) {
  const mounted = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    createSessions("main", keys),
    "panel",
    agents,
  );
  const { sidebar } = mounted;
  const q = (selector: string) => sidebar.querySelector<HTMLElement>(selector);
  const click = async (element: HTMLElement) => {
    element.click();
    await sidebar.updateComplete;
  };
  const remove = (menu: HTMLElement) =>
    click(menu.querySelector<HTMLElement>('[data-value="remove"]')!);
  const hide = async (menu: HTMLElement | null) => {
    menu?.dispatchEvent(new CustomEvent("overlay-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
  };
  const openPin = async (entry: string) => {
    const pin = q(`.sidebar-rail [data-sidebar-entry="${entry}"]`)!;
    expect(pin).not.toBeNull();
    pin.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }),
    );
    await sidebar.updateComplete;
    const menu = q(".sidebar-rail-pin-menu")!;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.closest("openclaw-menu-surface")).toBeNull();
    return menu;
  };
  return { ...mounted, q, click, remove, hide, openPin };
}

it("AppSidebar keeps filters open after a choice and closes from the trigger", async () => {
  const { sidebar, q, click } = await mountMenus(["agent:main:main", "agent:main:task"]);
  const trigger = q(".sidebar-session-sort")!;

  await click(trigger);
  const firstMenu = q(".sidebar-session-sort-menu");
  expect(firstMenu).not.toBeNull();
  await activateSessionMenuValue(sidebar, "sort:updated");
  expect(q(".sidebar-session-sort-menu")).toBe(firstMenu);
  await click(trigger);
  expect(q(".sidebar-session-sort-menu")).toBeNull();
});

it("AppSidebar ignores a stale agent-menu hide after opening its replacement", async () => {
  const { q, click, hide } = await mountMenus(undefined, TWO_AGENTS);
  const trigger = q(".sidebar-agent-card__main")!;

  await click(trigger);
  const firstMenu = q(".sidebar-agent-menu");
  const settingsItem = firstMenu?.querySelector<HTMLElement>(
    '[data-value="command:agent-settings"]',
  );
  expect(firstMenu).not.toBeNull();
  expect(firstMenu?.closest("openclaw-menu-surface")).toBeNull();
  expect(settingsItem).not.toBeNull();
  await click(settingsItem!);

  await click(trigger);
  const replacement = q(".sidebar-agent-menu");
  expect(replacement).not.toBe(firstMenu);

  await hide(firstMenu);
  expect(q(".sidebar-agent-menu")).toBe(replacement);
});

it.each(["recreated", "different"] as const)("AppSidebar isolates %s pin menus", async (kind) => {
  const { sidebar, q, click, remove, hide, openPin } = await mountMenus();
  const recreated = kind === "recreated";
  sidebar.sidebarEntries = recreated ? ["route:usage"] : ["route:usage", "route:plugins"];
  const update = vi.fn((entries: string[]) => {
    sidebar.sidebarEntries = entries;
  });
  sidebar.onUpdateSidebarEntries = update;
  await sidebar.updateComplete;
  const first = await openPin("route:usage");
  if (recreated) {
    await remove(first);
    expect(sidebar.sidebarEntries).toEqual([]);
    expect(first.isConnected).toBe(false);
    await selectSidebarView(sidebar, "pages");
    const page = q('.sidebar-pages [data-sidebar-entry="route:usage"]')!;
    await click(
      page
        .closest(".sidebar-pages__entry")!
        .querySelector<HTMLButtonElement>('[aria-label="Pin"]')!,
    );
  }
  const replacement = await openPin(recreated ? "route:usage" : "route:plugins");
  expect(replacement).not.toBe(first);
  const writes = update.mock.calls.length;
  await hide(first);
  expect(replacement.getAttribute("role")).toBe("menu");
  if (recreated) {
    expect(replacement.isConnected).toBe(true);
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    expect(update).toHaveBeenCalledTimes(writes);
  } else {
    await remove(replacement);
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    expect(q('.sidebar-rail [data-sidebar-entry="route:plugins"]')).toBeNull();
    expect(q('.sidebar-rail [data-sidebar-entry="route:usage"]')).not.toBeNull();
  }
});
