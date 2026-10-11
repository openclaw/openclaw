import { createSignal, For, merge, onSettled, Show } from "solid-js";
import { t } from "../i18n/index.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { DropdownMenuController } from "./dropdown-menu-controller.ts";
import { activateMenuShortcut } from "./menu-shortcuts.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
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
import { useSessionMenuControllers } from "./session-menu-controllers.ts";
import { SessionMenuItem } from "./session-menu-item.tsx";
import { SessionMenuShortcut, useSessionMenuView } from "./session-menu-view.tsx";
import type { SessionCreatedActor } from "./session-owner-chip.ts";
import { Icon } from "./solid/icon.tsx";

/** Only resolved local worktree destinations are offered by the menu host. */
export type SessionMenuWork = {
  loading: boolean;
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

function SessionMenuContent(props: SessionMenuProps, host: SolidBridgeElement<SessionMenuProps>) {
  // Legacy controllers can synchronously invalidate while reconciling after render.
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [compactView, setCompactView] = createSignal<CompactSessionMenuView>("root");
  const state = merge(props, {
    get worktreePath() {
      return props.work?.worktreePath ?? null;
    },
  });
  const readState = () => state;
  const application = useOptionalApplication();
  const controllerHost = useSessionMenuControllers(
    host,
    application,
    () => setRevision((value) => value + 1),
    () => {
      revision();
      return Object.values(props);
    },
  );
  const actions = new SessionMenuActions(
    controllerHost,
    readState,
    (action) => props.onAction(action),
    () => props.onClose(),
  );
  const view = useSessionMenuView(host, actions, readState, revision);
  Object.assign(host, {
    menuLifecycle: new DropdownMenuController(controllerHost, {
      getTrigger: () => props.trigger,
      onClose: () => props.onClose(),
      onKeydown: (event) => {
        if (!actions.handleKeydown(event, view.appearance)) {
          activateMenuShortcut(host, event);
        }
      },
    }),
  });
  onSettled(() => promoteToPopoverTopLayer(host));
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
    props.onClose();
    props.onAction(action);
  };
  const handleSelect = (event: CustomEvent<{ item: { value?: string } }>) => {
    event.preventDefault();
    const value = event.detail.item.value;
    if (!value) {
      return;
    }
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
      const id = value.slice("plugin:".length);
      const action = props.pluginActions.find((candidate) => candidate.id === id);
      if (action && props.selectionCount === 1 && !actionDisabled("plugin", action.disabled)) {
        runAction({ kind: "plugin", id });
      }
    } else if (value === "stop-cloud-worker") {
      runAction({ kind: value });
    } else if (value === "open-pr" && props.work?.pullRequestUrl) {
      runAction({ kind: "open-pr", url: props.work.pullRequestUrl });
    }
  };
  const RootMenu = () => (
    <>
      <Show when={!batch() && Boolean(props.lastActive)}>
        <div class="session-menu__info">
          {t("sessionsView.lastActive", { time: props.lastActive })}
        </div>
      </Show>
      <view.Primary />
      <div class="session-menu__separator" role="separator" />
      <view.Organization />
      <Show when={!batch()}>
        <For each={props.pluginActions} keyed={(action) => action.id}>
          {(action) => (
            <SessionMenuItem
              class="session-menu__item"
              value={`plugin:${action().id}`}
              disabled={actionDisabled("plugin", action().disabled)}
              title={props.actionDisabledReasons.plugin}
            >
              <span slot="icon" class="session-menu__icon" aria-hidden="true">
                <Icon name="plug" />
              </span>
              <span class="session-menu__text">{action().label}</span>
            </SessionMenuItem>
          )}
        </For>
      </Show>
      <Show when={!batch() && Boolean(props.work?.pullRequestUrl)}>
        <div class="session-menu__separator" role="separator" />
        <SessionMenuItem
          class="session-menu__item"
          value="open-pr"
          data-new-tab-action=""
          data-shortcut="g"
          aria-keyshortcuts="G"
          disabled={props.disabled}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">
            <Icon name="gitPullRequest" />
          </span>
          <span class="session-menu__text">{t("sessionsView.openPullRequest")}</span>
          <SessionMenuShortcut shortcut="g" />
        </SessionMenuItem>
      </Show>
      <div class="session-menu__separator" role="separator" />
      <Show when={!batch() && props.cloudWorkerStopAllowed}>
        <SessionMenuItem
          class="session-menu__item session-menu__item--destructive"
          value="stop-cloud-worker"
          variant="danger"
          disabled={actionDisabled("stop-cloud-worker")}
          title={props.actionDisabledReasons["stop-cloud-worker"]}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">
            <Icon name="stop" />
          </span>
          <span class="session-menu__text">{t("sessionsView.stopCloudWorker")}</span>
        </SessionMenuItem>
      </Show>
      <Show when={batch()} fallback={<view.Advanced />}>
        <view.DeleteAction />
      </Show>
    </>
  );
  return (
    <Show when={props.anchor} keyed>
      {(anchor) => (
        <wa-dropdown
          class={["session-menu", { "session-menu--compact": props.compact }]}
          prop:open={true}
          placement="bottom-start"
          prop:distance={0}
          aria-label={label()}
          onWa-show={actions.loadOwners}
          onWa-select={handleSelect}
          onWa-after-hide={(event) => {
            // A replaced dropdown can finish closing after its successor has opened.
            if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
              actions.advanced.close();
              props.onClose();
            }
          }}
        >
          <button
            slot="trigger"
            type="button"
            tabindex={-1}
            aria-hidden="true"
            aria-label={label()}
            style={{
              position: "fixed",
              left: `${Math.max(8, Math.min(anchor.x, window.innerWidth - 248))}px`,
              top: `${Math.max(8, Math.min(anchor.y, window.innerHeight - 468))}px`,
              width: "1px",
              height: "1px",
              opacity: "0",
              "pointer-events": "none",
            }}
          />
          <Show when={props.compact && compactView() !== "root"} fallback={<RootMenu />}>
            <view.Compact view={compactView()} />
          </Show>
        </wa-dropdown>
      )}
    </Show>
  );
}

export const SessionMenu = defineSolidBridge<SessionMenuProps>(
  "openclaw-session-menu",
  SessionMenuContent,
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
