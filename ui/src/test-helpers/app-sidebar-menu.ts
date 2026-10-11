import { expect } from "vitest";
import type { SidebarLifecycleState } from "./app-sidebar.ts";
import { waitForFast } from "./wait-for.ts";

type SessionMenuHost = Pick<
  SidebarLifecycleState,
  "querySelector" | "querySelectorAll" | "updateComplete" | "sessionData"
>;

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
  return menu.querySelector<HTMLInputElement>(
    `#sidebar-sessions-${ids[kind!]} .settings-segmented__input[value="${option}"]`,
  );
}

export async function openSessionMenu(sidebar: SessionMenuHost): Promise<HTMLElement> {
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

export async function activateSessionMenuValue(sidebar: SessionMenuHost, value: string) {
  if (value === "involving-me" || value.startsWith("owner:")) {
    const trigger = sidebar.querySelector<HTMLButtonElement>("#sidebar-session-owner-title")!;
    if (trigger.getAttribute("aria-expanded") !== "true") {
      trigger.click();
    }
    await waitForFast(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
    const selected = value === "owner:" ? "all" : value;
    const option = [...sidebar.querySelectorAll<HTMLElement>("[role=option]")].find(
      (item) => item.dataset.value === selected,
    );
    if (!option) {
      throw new Error(`Expected owner choice ${value}`);
    }
    option.click();
    await sidebar.updateComplete;
    return;
  }
  const menu = await openSessionMenu(sidebar);
  if (
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
    const id = displayIds[kind!];
    const selected = choice;
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
    input.click();
  }
  await sidebar.updateComplete;
}

export async function selectSessionMenuValue(sidebar: SessionMenuHost, value: string) {
  await activateSessionMenuValue(sidebar, value);
  await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
  await sidebar.updateComplete;
}
