import { createMemo, createSignal, merge, onSettled, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import type { SessionCreatedActor } from "../lib/session-owner.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { activateMenuShortcut } from "./menu-shortcut-activation.ts";
import {
  EMPTY_SESSION_MENU_DATA,
  SessionMenuActions,
  type SessionManagementAction,
  type SessionMenuData,
} from "./session-menu-actions.ts";
import {
  compactSessionMenuViewForValue,
  type CompactSessionMenuView,
} from "./session-menu-compact.ts";
import { SessionMenuShortcut, useSessionMenuEntries } from "./session-menu-view.tsx";
import { Icon } from "./solid/icon.tsx";
import { pointMenuTriggerAttributes } from "./solid/menu-trigger.tsx";
import {
  createMenuControls,
  Menu,
  type MenuEntry,
  type MenuItem,
  type MenuHandle,
} from "./solid/menu.tsx";

/** Only resolved local worktree destinations are offered by the menu host. */
export type SessionMenuWork = {
  pullRequestUrl: string | null;
  worktreePath: string | null;
};
export type SessionMenuAction =
  | SessionManagementAction
  | { kind: "open-pr"; url: string }
  | { kind: "plugin"; id: string }
  | { kind: "stop-cloud-worker" };
export type SessionMenuActionKind = SessionMenuAction["kind"];
export type PluginSessionMenuAction = { id: string; label: string; disabled?: boolean };

type SessionMenuProps = {
  session: SessionMenuData;
  compact: boolean;
  involvingMeContext: boolean;
  navigationAllowed: boolean;
  copyMarkdownAllowed: boolean;
  splitAllowed: boolean;
  selectionCount: number;
  lastActive: string;
  anchor: { x: number; y: number };
  trigger: HTMLElement | null;
  disabled: boolean;
  actionDisabledReasons: Partial<Record<SessionMenuActionKind, string>>;
  forkDisabled: boolean;
  forkFromLastCompleted: boolean;
  archiveAllowed: boolean;
  snoozeAllowed: boolean;
  deleteAllowed: boolean;
  cloudWorkerStopAllowed: boolean;
  groups: readonly string[];
  currentOwner: SessionCreatedActor | null;
  work: SessionMenuWork | null;
  pluginActions: readonly PluginSessionMenuAction[];
  onAction: (action: SessionMenuAction) => void;
  onClose: () => void;
};

let nextSessionMenuId = 0;
function SessionMenuContent(
  props: SessionMenuProps,
  host: SolidBridgeElement<SessionMenuProps>,
  anchor: SessionMenuProps["anchor"],
) {
  const menuId = `session-menu-${++nextSessionMenuId}`;
  const controls = createMenuControls();
  const [compactView, setCompactView] = createSignal<CompactSessionMenuView>("root");
  let menu: MenuHandle | undefined;
  const state = merge(props, {
    get worktreePath() {
      return props.work?.worktreePath ?? null;
    },
  });
  const readState = () => state;
  let closeNotified = false;
  const notifyClosed = () => {
    if (!closeNotified) {
      closeNotified = true;
      props.onClose();
    }
  };
  const close = () => {
    if (menu?.close()) {
      notifyClosed();
    }
  };
  const actions = new SessionMenuActions(
    {
      get updateComplete() {
        return host.updateComplete;
      },
      focusCurrentView() {
        if (compactView() === "icon") {
          view.appearance.focusFirst();
        } else {
          menu?.focusFirst();
        }
      },
    },
    readState,
    (action) => props.onAction(action),
    close,
  );
  const view = useSessionMenuEntries(actions, readState, { controls });
  const shortcut = (event: KeyboardEvent) => {
    if (!actions.handleKeydown(event, view.appearance)) {
      activateMenuShortcut(menu?.overlay.surface, event);
    }
  };
  let stopShortcut: (() => void) | undefined;
  let stopAfterHide: (() => void) | undefined;
  onSettled(() => () => {
    stopShortcut?.();
    stopAfterHide?.();
  });
  const batch = () => props.selectionCount > 1;
  const label = () =>
    batch()
      ? t("chat.sidebar.sessionMenuMany", { count: String(props.selectionCount) })
      : t("chat.sidebar.sessionMenu", { session: props.session.label });
  const actionDisabled = (kind: SessionMenuActionKind, extra = false) =>
    props.disabled || extra || Boolean(props.actionDisabledReasons[kind]);
  const runAction = (action: SessionMenuAction) => {
    if (props.actionDisabledReasons[action.kind]) {
      return;
    }
    close();
    props.onAction(action);
  };
  const separator = (id: string): MenuEntry => ({
    kind: "content",
    id,
    content: <div class="session-menu__separator" role="separator" />,
  });
  const primaryDivider = separator("primary-divider");
  const prDivider = separator("pr-divider");
  const advancedDivider = separator("advanced-divider");
  const lastActive: MenuEntry = {
    kind: "content",
    id: "last-active",
    content: (
      <div class="session-menu__info">
        {t("sessionsView.lastActive", { time: props.lastActive })}
      </div>
    ),
  };
  const items = createMemo((): MenuEntry[] => {
    if (props.compact && compactView() !== "root") {
      return view.compact(compactView());
    }
    return [
      ...(!batch() && props.lastActive ? [lastActive] : []),
      ...view.primary(),
      primaryDivider,
      ...view.organization(),
      ...(!batch()
        ? props.pluginActions.map((action) => ({
            id: `plugin:${action.id}`,
            label: action.label,
            class: "session-menu__item",
            labelClass: "session-menu__text",
            disabled: actionDisabled("plugin", action.disabled),
            attributes: { title: props.actionDisabledReasons.plugin },
            icon: (
              <span class="session-menu__icon" aria-hidden="true">
                <Icon name="plug" />
              </span>
            ),
            closeOnSelect: false,
          }))
        : []),
      ...(!batch() && props.work?.pullRequestUrl
        ? [
            prDivider,
            {
              id: "open-pr",
              label: t("sessionsView.openPullRequest"),
              class: "session-menu__item",
              labelClass: "session-menu__text",
              disabled: props.disabled,
              attributes: {
                "data-new-tab-action": "",
                "data-shortcut": "g",
                "aria-keyshortcuts": "G",
              },
              icon: (
                <span class="session-menu__icon" aria-hidden="true">
                  <Icon name="gitPullRequest" />
                </span>
              ),
              details: <SessionMenuShortcut shortcut="g" />,
              closeOnSelect: false,
            },
          ]
        : []),
      advancedDivider,
      ...(!batch() && props.cloudWorkerStopAllowed
        ? [
            {
              id: "stop-cloud-worker",
              label: t("sessionsView.stopCloudWorker"),
              class: "session-menu__item session-menu__item--destructive",
              labelClass: "session-menu__text",
              variant: "danger" as const,
              disabled: actionDisabled("stop-cloud-worker"),
              attributes: { title: props.actionDisabledReasons["stop-cloud-worker"] },
              icon: (
                <span class="session-menu__icon" aria-hidden="true">
                  <Icon name="stop" />
                </span>
              ),
              closeOnSelect: false,
            },
          ]
        : []),
      ...(batch() ? [view.deleteAction()] : view.advanced()),
    ];
  });
  const select = (item: MenuItem, event: CustomEvent<MenuItem>) => {
    event.preventDefault();
    const value = item.id;
    const nextView = compactSessionMenuViewForValue(value);
    if (nextView) {
      setCompactView(nextView);
      if (nextView === "icon") {
        view.appearance.prepare();
      }
      onSettled(() => actions.focusCurrentView());
      return;
    }
    if (actions.handleSelect(value)) {
      return;
    }
    if (value.startsWith("plugin:")) {
      const action = props.pluginActions.find(
        (candidate) => candidate.id === value.slice("plugin:".length),
      );
      if (action && props.selectionCount === 1 && !actionDisabled("plugin", action.disabled)) {
        runAction({ kind: "plugin", id: action.id });
      }
    } else if (value === "stop-cloud-worker") {
      runAction({ kind: value });
    } else if (value === "open-pr" && props.work?.pullRequestUrl) {
      runAction({ kind: "open-pr", url: props.work.pullRequestUrl });
    }
  };
  const closed = () => {
    if (props.anchor === anchor && menu?.overlay.surface.isConnected) {
      notifyClosed();
    }
  };
  const afterHide = (event: Event) => {
    if (event.target === menu?.overlay.surface) {
      closed();
    }
  };
  return (
    <Menu
      controls={controls}
      id={menuId}
      class={["session-menu", { "session-menu--compact": props.compact }]}
      panelClass="session-menu__panel"
      placement="bottom-start"
      label={label()}
      items={items()}
      onSelect={select}
      triggerAttributes={pointMenuTriggerAttributes({
        x: Math.max(8, Math.min(anchor.x, window.innerWidth - 248)),
        y: Math.max(8, Math.min(anchor.y, window.innerHeight - 468)),
      })}
      ref={(handle) => {
        menu = handle;
        if (props.trigger) {
          handle.overlay.setReturnTarget(props.trigger);
        }
        stopShortcut?.();
        stopAfterHide?.();
        stopShortcut = listen(handle.overlay.surface, "keydown", shortcut, true);
        stopAfterHide = listen(handle.overlay.surface, "overlay-after-hide", afterHide);
        if (!handle.open()) {
          closed();
        }
      }}
      onBeforeShow={actions.loadOwners}
      onEscape={(event) => {
        if (actions.handleKeydown(event, view.appearance)) {
          return true;
        }
        // Shared Menu owns child dismissal and clearing a nonempty search.
        if (
          [...(menu?.overlay.children ?? [])].some((child) => child.open) ||
          (event.target instanceof HTMLInputElement &&
            event.target.hasAttribute("data-search") &&
            event.target.value)
        ) {
          return false;
        }
        close();
        return true;
      }}
      onOpenChange={(open) => {
        if (open) {
          closeNotified = false;
        } else {
          actions.advanced.close();
        }
      }}
    />
  );
}

export const SessionMenu = defineSolidBridge<SessionMenuProps>(
  "openclaw-session-menu",
  (props, host) => (
    <Show when={props.anchor} keyed>
      {(anchor) => SessionMenuContent(props, host, anchor)}
    </Show>
  ),
  {
    properties: {
      session: { default: EMPTY_SESSION_MENU_DATA, attribute: false },
      compact: { default: false, attribute: false },
      involvingMeContext: { default: false, attribute: false },
      navigationAllowed: { default: false, attribute: false },
      copyMarkdownAllowed: { default: false, attribute: false },
      splitAllowed: { default: false, attribute: false },
      selectionCount: { default: 1, attribute: false },
      lastActive: { default: "", attribute: false },
      anchor: { default: { x: 0, y: 0 }, attribute: false },
      trigger: { default: null, attribute: false },
      disabled: { default: false, attribute: false },
      actionDisabledReasons: { default: {}, attribute: false },
      forkDisabled: { default: false, attribute: false },
      forkFromLastCompleted: { default: false, attribute: false },
      archiveAllowed: { default: false, attribute: false },
      snoozeAllowed: { default: false, attribute: false },
      deleteAllowed: { default: false, attribute: false },
      cloudWorkerStopAllowed: { default: false, attribute: false },
      groups: { default: [], attribute: false },
      currentOwner: { default: null, attribute: false },
      work: { default: null, attribute: false },
      pluginActions: { default: [], attribute: false },
      onAction: { default: () => {}, attribute: false },
      onClose: { default: () => {}, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-menu": SolidBridgeElement<SessionMenuProps>;
  }
}
