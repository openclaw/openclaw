import { expectDefined } from "@openclaw/normalization-core";
import { afterEach } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import type { SessionMenuData } from "../components/session-menu-actions.ts";
import { EMPTY_SESSION_MENU_DATA } from "../components/session-menu-data.ts";
import "../components/session-menu-solid.tsx";
import type { SessionOwnerOption } from "../lib/session-owner.ts";
import { createApplicationContextProvider } from "./application-context.ts";
import { flush } from "./solid-settle.ts";
type SessionMenuElement = HTMLElementTagNameMap["openclaw-session-menu"];
type MenuProps = Omit<SessionMenuElement, keyof HTMLElement | "updateComplete">;
type MenuOptions = Partial<
  Omit<MenuProps, "session" | "anchor" | "disabled" | "forkDisabled" | "currentOwner">
> & {
  session?: Partial<SessionMenuData>;
  context?: ApplicationContext;
  currentOwner?: SessionOwnerOption | null;
};

export const containers: HTMLElement[] = [];

afterEach(() => containers.splice(0).forEach((container) => container.remove()));

export async function mountMenu(options: MenuOptions = {}): Promise<SessionMenuElement> {
  const { context, session: overrides, ...props } = options;
  const container = context
    ? createApplicationContextProvider(context)
    : document.createElement("div");
  containers.push(container);
  document.body.append(container);
  const session: SessionMenuData = {
    ...EMPTY_SESSION_MENU_DATA,
    label: "Test session",
    sessionId: "session-123",
    ...overrides,
  };
  const element = document.createElement("openclaw-session-menu");
  Object.assign(element, {
    session,
    navigationAllowed: true,
    copyMarkdownAllowed: true,
    archiveAllowed: true,
    lastActive: "57d",
    anchor: { x: 100, y: 100 },
    actionDisabledReasons: {},
    groups: [],
    pluginActions: [],
    ...Object.fromEntries(Object.entries(props).filter(([, value]) => value != null)),
    deleteAllowed: options.deleteAllowed ?? (session.archived || (options.archiveAllowed ?? true)),
  });
  container.append(element);
  await settleSessionMenu(element);
  return element;
}

export async function settleSessionMenu(menu: SessionMenuElement): Promise<void> {
  await menu.updateComplete;
  flush();
  await Promise.resolve();
}

export function menuPanel(menu: ParentNode): HTMLElement {
  return expectDefined(
    menu instanceof HTMLButtonElement
      ? document.getElementById(menu.getAttribute("aria-controls") ?? "")
      : menu instanceof HTMLElement && menu.matches('[role="menu"]')
        ? menu
        : menu.querySelector<HTMLElement>(".session-menu__panel"),
    "native menu panel",
  );
}

function itemLabel(item: HTMLButtonElement): string {
  return item.getAttribute("aria-label") ?? "";
}

export function menuItemLabels(menu: ParentNode): string[] {
  const panel = menuPanel(menu);
  return [...panel.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]')]
    .filter((item) => item.closest('[role="menu"]') === panel)
    .map(itemLabel);
}

export function menuItem(menu: ParentNode, label: string): HTMLButtonElement {
  return expectDefined(
    [...menuPanel(menu).querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]')].find(
      (candidate) => itemLabel(candidate) === label,
    ),
    `menu item: ${label}`,
  );
}

export async function openSubmenu(menu: ParentNode, label: string): Promise<HTMLElement> {
  const trigger = menuItem(menu, label);
  const panel = menuPanel(trigger);
  if (trigger.disabled || !trigger.closest('[role="menu"]')?.matches(":popover-open")) {
    throw new Error(`Expected enabled submenu trigger in an open panel: ${label}`);
  }
  trigger.focus();
  trigger.click();
  flush();
  await Promise.resolve();
  if (!panel.matches(":popover-open")) {
    throw new Error(`Expected open submenu: ${label}`);
  }
  return panel;
}

export function iconChoices(menu: ParentNode): HTMLButtonElement[] {
  return [...menuPanel(menu).querySelectorAll<HTMLButtonElement>(".session-menu__icon-choice")];
}

export async function selectMenuValue(menu: SessionMenuElement, value: string) {
  const item = [...menu.querySelectorAll<HTMLButtonElement>("button[value]")].find(
    (candidate) =>
      candidate.value === value &&
      !candidate.disabled &&
      candidate.closest('[role="menu"]')?.matches(":popover-open"),
  );
  if (!item) {
    throw new Error(`Expected enabled menu action in an open panel: ${value}`);
  }
  item.focus();
  item.click();
  await settleSessionMenu(menu);
}
