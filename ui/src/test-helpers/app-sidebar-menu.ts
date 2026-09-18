import { expect } from "vitest";
import type { SidebarLifecycleState } from "./app-sidebar.ts";
import { waitForFast } from "./wait-for.ts";

export function sessionMenuChoice(menu: Element, value: string) {
  const [kind, option] = value.split(":");
  const ids: Record<string, string> = {
    grouping: "group",
    sort: "sort",
    status: "status",
    "empty-groups": "empty",
  };
  return menu.querySelector<HTMLInputElement>(
    `#sidebar-sessions-${ids[kind!]} input[value="${option}"]`,
  );
}

export async function openSessionMenu(sidebar: SidebarLifecycleState): Promise<HTMLElement> {
  if (!sidebar.querySelector(".sidebar-session-sort-menu")) {
    sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")!.click();
    await sidebar.updateComplete;
  }
  const menu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu")!;
  await waitForFast(() =>
    expect(menu.querySelector(".sidebar-session-filter-panel")).not.toBeNull(),
  );
  return menu;
}

export async function activateSessionMenuValue(sidebar: SidebarLifecycleState, value: string) {
  const menu = await openSessionMenu(sidebar);
  if (value === "involving-me" || value.startsWith("owner:")) {
    const select = menu.querySelector<HTMLSelectElement>("#sidebar-sessions-owner")!;
    select.value = value === "owner:" ? "all" : value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (value.startsWith("show-")) {
    const ids: Record<string, string> = {
      "show-preview": "preview",
      "show-cron": "cron",
      "show-system": "system",
    };
    menu.querySelector<HTMLButtonElement>(`#sidebar-sessions-${ids[value]}`)!.click();
  } else {
    const input = sessionMenuChoice(menu, value);
    if (!input) {
      throw new Error(`Expected session choice ${value}`);
    }
    input.click();
  }
  await sidebar.updateComplete;
}

export async function selectSessionMenuValue(sidebar: SidebarLifecycleState, value: string) {
  await activateSessionMenuValue(sidebar, value);
  await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
  await sidebar.updateComplete;
}
