import { html, render } from "lit";
import { afterEach } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { SessionMenuData } from "../components/session-menu-actions.ts";
import "../components/session-menu.ts";
import type {
  PluginSessionMenuAction,
  SessionMenuAction,
  SessionMenuActionKind,
  SessionMenuWork,
} from "../components/session-menu.ts";
import type { SessionOwnerOption } from "../components/session-owner-chip.ts";
import { createApplicationContextProvider } from "./application-context.ts";
type SessionMenuElement = HTMLElement & {
  anchor: { x: number; y: number };
  compact: boolean;
  lastActive: string;
  session: SessionMenuData;
  updateComplete: Promise<boolean>;
};
export type SessionMenuItem = HTMLElement & { disabled: boolean; updateComplete: Promise<unknown> };

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
    navigationAllowed?: boolean;
    copyMarkdownAllowed?: boolean;
    splitAllowed?: boolean;
    work?: SessionMenuWork | null;
    pluginActions?: readonly PluginSessionMenuAction[];
    archiveAllowed?: boolean;
    deleteAllowed?: boolean;
    cloudWorkerStopAllowed?: boolean;
    selectionCount?: number;
    lastActive?: string;
    groups?: readonly string[];
    context?: ApplicationContext<RouteId>;
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
    category: null,
    icon: null,
    color: null,
    categoryClearReturnsToGroups: false,
    ...options.session,
  };
  render(
    html`<openclaw-session-menu
      .session=${session}
      .compact=${options.compact ?? false}
      .navigationAllowed=${options.navigationAllowed ?? true}
      .copyMarkdownAllowed=${options.copyMarkdownAllowed ?? true}
      .splitAllowed=${options.splitAllowed ?? false}
      .selectionCount=${options.selectionCount ?? 1}
      .lastActive=${options.lastActive ?? "57d"}
      .anchor=${{ x: 100, y: 100 }}
      .trigger=${options.trigger ?? null}
      .disabled=${false}
      .actionDisabledReasons=${options.actionDisabledReasons ?? {}}
      .forkDisabled=${false}
      .forkFromLastCompleted=${options.forkFromLastCompleted ?? false}
      .archiveAllowed=${options.archiveAllowed ?? true}
      .deleteAllowed=${
        options.deleteAllowed ?? (session.archived || (options.archiveAllowed ?? true))
      }
      .cloudWorkerStopAllowed=${options.cloudWorkerStopAllowed ?? false}
      .groups=${options.groups ?? []}
      .currentOwner=${options.currentOwner ?? null}
      .work=${options.work ?? null}
      .pluginActions=${options.pluginActions ?? []}
      .onAction=${options.onAction ?? (() => {})}
      .onClose=${options.onClose ?? (() => {})}
    ></openclaw-session-menu>`,
    container,
  );
  const element = container.querySelector<SessionMenuElement>("openclaw-session-menu");
  if (!element) {
    throw new Error("Expected session menu");
  }
  await element.updateComplete;
  return element;
}

function itemLabel(item: HTMLElement): string {
  return item.querySelector(".session-menu__text")?.textContent?.trim() ?? "";
}

export function menuItemLabels(menu: ParentNode): string[] {
  const selector =
    menu instanceof Element && menu.matches("wa-dropdown-item")
      ? ":scope > wa-dropdown-item[slot='submenu']"
      : ":scope > wa-dropdown > wa-dropdown-item";
  return Array.from(menu.querySelectorAll<HTMLElement>(selector)).map(itemLabel);
}

export function menuItem(menu: ParentNode, label: string): SessionMenuItem {
  const item = Array.from(menu.querySelectorAll<SessionMenuItem>("wa-dropdown-item")).find(
    (candidate) => itemLabel(candidate) === label,
  );
  if (!item) {
    throw new Error(`Expected menu item: ${label}`);
  }
  return item;
}

export function iconChoices(menu: ParentNode): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>(".session-menu__icon-choice"));
}

export function selectMenuValue(menu: SessionMenuElement, value: string) {
  menu.querySelector("wa-dropdown")?.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      composed: true,
      detail: { item: { value } },
    }),
  );
}
