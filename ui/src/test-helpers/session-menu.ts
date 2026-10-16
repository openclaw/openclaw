import { afterEach } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import type { SessionMenuData } from "../components/session-menu-actions.ts";
import type {
  PluginSessionMenuAction,
  SessionMenuAction,
  SessionMenuActionKind,
  SessionMenuWork,
} from "../components/session-menu.ts";
import "../components/session-menu.ts";
import type { SessionOwnerOption } from "../lib/session-owner.ts";
import { createApplicationContextProvider } from "./application-context.ts";
import { flush } from "./solid-settle.ts";
type SessionMenuElement = HTMLElementTagNameMap["openclaw-session-menu"];

export const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

export async function mountMenu(
  options: {
    session?: Partial<SessionMenuData>;
    compact?: boolean;
    involvingMeContext?: boolean;
    navigationAllowed?: boolean;
    copyMarkdownAllowed?: boolean;
    splitAllowed?: boolean;
    work?: SessionMenuWork | null;
    pluginActions?: readonly PluginSessionMenuAction[];
    archiveAllowed?: boolean;
    snoozeAllowed?: boolean;
    deleteAllowed?: boolean;
    cloudWorkerStopAllowed?: boolean;
    selectionCount?: number;
    lastActive?: string;
    groups?: readonly string[];
    context?: ApplicationContext;
    currentOwner?: SessionOwnerOption | null;
    trigger?: HTMLElement | null;
    onAction?: (action: SessionMenuAction) => void;
    onClose?: () => void;
    actionDisabledReasons?: Partial<Record<SessionMenuActionKind, string>>;
    forkFromLastCompleted?: boolean;
  } = {},
): Promise<SessionMenuElement> {
  const container = options.context
    ? createApplicationContextProvider(options.context)
    : document.createElement("div");
  containers.push(container);
  document.body.append(container);
  const session: SessionMenuData = {
    label: "Test session",
    sessionId: "session-123",
    isChild: false,
    pinned: false,
    unread: false,
    archived: false,
    snoozedUntil: null,
    category: null,
    icon: null,
    color: null,
    categoryClearReturnsToGroups: false,
    ...options.session,
  };
  const element = document.createElement("openclaw-session-menu");
  Object.assign(element, {
    session,
    compact: options.compact ?? false,
    involvingMeContext: options.involvingMeContext ?? false,
    navigationAllowed: options.navigationAllowed ?? true,
    copyMarkdownAllowed: options.copyMarkdownAllowed ?? true,
    splitAllowed: options.splitAllowed ?? false,
    selectionCount: options.selectionCount ?? 1,
    lastActive: options.lastActive ?? "57d",
    anchor: { x: 100, y: 100 },
    trigger: options.trigger ?? null,
    disabled: false,
    actionDisabledReasons: options.actionDisabledReasons ?? {},
    forkDisabled: false,
    forkFromLastCompleted: options.forkFromLastCompleted ?? false,
    snoozeAllowed: options.snoozeAllowed ?? false,
    archiveAllowed: options.archiveAllowed ?? true,
    deleteAllowed: options.deleteAllowed ?? (session.archived || (options.archiveAllowed ?? true)),
    cloudWorkerStopAllowed: options.cloudWorkerStopAllowed ?? false,
    groups: options.groups ?? [],
    currentOwner: options.currentOwner ?? null,
    work: options.work ?? null,
    pluginActions: options.pluginActions ?? [],
    onAction: options.onAction ?? (() => {}),
    onClose: options.onClose ?? (() => {}),
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
  const panel =
    menu instanceof HTMLButtonElement
      ? document.getElementById(menu.getAttribute("aria-controls") ?? "")
      : menu instanceof HTMLElement && menu.matches('[role="menu"]')
        ? menu
        : menu.querySelector<HTMLElement>(".session-menu__panel");
  if (!panel) {
    throw new Error("Expected native menu panel");
  }
  return panel;
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
  const item = [
    ...menuPanel(menu).querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]'),
  ].find((candidate) => itemLabel(candidate) === label);
  if (!item) {
    throw new Error(`Expected menu item: ${label}`);
  }
  return item;
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
