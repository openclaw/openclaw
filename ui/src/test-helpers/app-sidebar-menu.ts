import { expect } from "vitest";
import type { SidebarLifecycleState } from "./app-sidebar.ts";
import { waitForFast } from "./wait-for.ts";

const choiceLabels: Record<string, readonly [string, string]> = {
  "grouping:category": ["Group by", "Custom groups"],
  "grouping:project": ["Group by", "Project"],
  "grouping:person": ["Group by", "Person"],
  "grouping:none": ["Group by", "None"],
  "sort:created": ["Sort by", "Created"],
  "sort:updated": ["Sort by", "Last updated"],
  "sort:people": ["Sort by", "Owners"],
  "status:active": ["Status", "Active"],
  "status:archived": ["Status", "Archived"],
  "status:all": ["Status", "All"],
};

export function sessionMenuChoice(menu: Element, value: string) {
  const labels = choiceLabels[value];
  if (!labels) {
    throw new Error(`Unknown session choice ${value}`);
  }
  return menu.querySelector<HTMLButtonElement>(
    `[role="group"][aria-label="${labels[0]}"] button[aria-label="${labels[1]}"]`,
  );
}

export async function openSessionMenu(sidebar: SidebarLifecycleState): Promise<HTMLElement> {
  if (!sidebar.querySelector(".sidebar-session-sort-menu")) {
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort");
    if (!trigger) {
      throw new Error("expected session sort trigger");
    }
    trigger.click();
    await sidebar.updateComplete;
  }
  const menu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu");
  if (!menu) {
    throw new Error("expected session sort menu");
  }
  await waitForFast(() =>
    expect(menu.querySelector(".sidebar-session-filter-panel")).not.toBeNull(),
  );
  return menu;
}

async function chooseSelect(menu: HTMLElement, label: string, optionLabel: string) {
  const trigger = menu.querySelector<HTMLButtonElement>(
    `.picker-select__trigger[aria-label^="${label}:"]`,
  );
  if (!trigger) {
    throw new Error(`Expected ${label} select`);
  }
  trigger.click();
  await waitForFast(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  const option = [
    ...menu.querySelectorAll<HTMLElement>(
      `[role="listbox"][aria-label="${label}"] [role="option"]`,
    ),
  ].find((candidate) => candidate.textContent?.trim() === optionLabel);
  if (!option) {
    throw new Error(`Expected ${label} option ${optionLabel}`);
  }
  option.click();
}

export async function openOwnerMenu(sidebar: SidebarLifecycleState): Promise<HTMLElement> {
  const menu = await openSessionMenu(sidebar);
  if (!menu.querySelector(".sidebar-session-owner-picker")) {
    await chooseSelect(menu, "Owners", "Specific owner");
    await sidebar.updateComplete;
  }
  await waitForFast(() =>
    expect(menu.querySelector(".sidebar-session-owner-picker")).not.toBeNull(),
  );
  const picker = menu.querySelector<HTMLElement>(".sidebar-session-owner-picker");
  if (!picker) {
    throw new Error("Expected specific owner picker");
  }
  return picker;
}

// Historical values remain in fixtures; interactions go through the current visible controls.
export async function activateSessionMenuValue(sidebar: SidebarLifecycleState, value: string) {
  const menu = await openSessionMenu(sidebar);
  if (choiceLabels[value]) {
    const button = sessionMenuChoice(menu, value);
    if (!button) {
      throw new Error(`Expected session choice ${value}`);
    }
    button.click();
  } else if (value === "involving-me" || value === "owner:") {
    await chooseSelect(menu, "Owners", value === "owner:" ? "All owners" : "Involving me");
  } else if (value.startsWith("owner:")) {
    const picker = await openOwnerMenu(sidebar);
    const item = [...picker.querySelectorAll("wa-dropdown-item")].find(
      (candidate) => candidate.getAttribute("value") === value,
    );
    if (!item) {
      throw new Error(`Expected owner ${value}`);
    }
    picker.dispatchEvent(new CustomEvent("wa-select", { bubbles: true, detail: { item } }));
  } else if (value.startsWith("empty-groups:")) {
    const labels: Record<string, string> = {
      "empty-groups:filtering": "When filtering",
      "empty-groups:always": "Always",
      "empty-groups:never": "Never",
    };
    await chooseSelect(menu, "Hide empty groups", labels[value]!);
  } else {
    const labels: Record<string, string> = {
      "show-preview": "Show message preview",
      "show-cron": "Show automation sessions",
      "show-system": "Show system sessions",
    };
    const label = [...menu.querySelectorAll("label")].find(
      (candidate) => candidate.textContent?.trim() === labels[value],
    );
    const input = label?.querySelector<HTMLInputElement>('input[role="switch"]');
    if (!input) {
      throw new Error(`Expected session switch ${value}`);
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
