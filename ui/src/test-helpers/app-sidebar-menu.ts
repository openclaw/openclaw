import type WaRadioGroup from "@awesome.me/webawesome/dist/components/radio-group/radio-group.js";
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
  if (kind !== "status") {
    return menu.querySelector<HTMLElement>(
      `#sidebar-sessions-${ids[kind!]} ~ wa-popup [data-value="${option}"]`,
    );
  }
  return menu.querySelector<HTMLElement>(
    `#sidebar-sessions-${ids[kind!]} wa-radio[value="${option}"]`,
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
  if (
    value === "involving-me" ||
    value.startsWith("owner:") ||
    value.startsWith("grouping:") ||
    value.startsWith("sort:") ||
    value.startsWith("empty-groups:")
  ) {
    const [kind, choice] = value.split(":");
    const displayIds: Record<string, string> = {
      grouping: "group",
      sort: "sort",
      "empty-groups": "empty",
    };
    const display = kind !== undefined && kind in displayIds;
    const id = display ? displayIds[kind!] : "owner";
    const selected = display ? choice : value === "owner:" ? "all" : value;
    menu.querySelector<HTMLButtonElement>(`#sidebar-sessions-${id}`)!.click();
    await waitForFast(() =>
      expect(menu.querySelector(`#sidebar-sessions-${id}`)?.getAttribute("aria-expanded")).toBe(
        "true",
      ),
    );
    const option = [...menu.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.dataset.value === selected,
    );
    if (!option) {
      throw new Error(`Expected session choice ${value}`);
    }
    option.click();
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
    const group = input.closest<WaRadioGroup>("wa-radio-group");
    if (!group) {
      throw new Error(`Expected radio group for ${value}`);
    }
    // Lit's Node export disables Web Awesome's click listener in jsdom.
    // Browser tests cover that listener; this harness drives its change boundary.
    group.value = input.getAttribute("value");
    await group.updateComplete;
    group.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  await sidebar.updateComplete;
}

export async function selectSessionMenuValue(sidebar: SidebarLifecycleState, value: string) {
  await activateSessionMenuValue(sidebar, value);
  await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
  await sidebar.updateComplete;
}
