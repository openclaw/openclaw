import { createSignal, onSettled, For, Show } from "solid-js";
import type { UiSettings } from "../../../app/settings.ts";
import { renderBoardGrantedCapabilities } from "../../../components/board/board-widget-capabilities.ts";
import {
  renderBoardWidgetMenuItems,
  type BoardWidgetPageMenu,
} from "../../../components/board/board-widget-cell-render.ts";
import { icons } from "../../../components/icons.ts";
import { activateMenuShortcut } from "../../../components/menu-shortcuts.ts";
import {
  EMPTY_SESSION_MENU_DATA,
  SessionMenuActions,
  type SessionManagementAction,
  type SessionMenuData,
} from "../../../components/session-menu-actions.ts";
import {
  compactSessionMenuViewForValue,
  renderCompactSessionMenuNavigationItem,
  type CompactSessionMenuView,
} from "../../../components/session-menu-compact.ts";
import { useSessionMenuControllers } from "../../../components/session-menu-controllers.ts";
import type { SessionCreatedActor } from "../../../components/session-owner-chip.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { i18nRevision, t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import type { LegacyTemplateResult as TemplateResult } from "../../../lit/solid-content.tsx";
import { LitContent } from "../../../lit/solid-content.tsx";
import { isChatBubbleMode, setChatBubbleMode } from "../chat-bubble-mode.ts";
import { renderHeaderTerminalAction } from "./chat-header-session-menu.ts";
import { ChatSessionSharing } from "./chat-session-sharing.solid.tsx";
import {
  canManageChatSessionSharing,
  selectChatSessionSharingItem,
  type ChatSessionSharingProps,
} from "./chat-session-sharing.ts";

export type HeaderMenuAction =
  | SessionManagementAction
  | { kind: "continue-in-terminal" }
  | { kind: "stop-cloud-worker" }
  | { kind: "plugin"; id: string };
export type HeaderMenuActionKind = HeaderMenuAction["kind"];

export type HeaderMenuQuickAction = {
  id: string;
  label: string;
  icon: TemplateResult;
  description?: string;
  variant?: "danger";
} & (
  | { kind: "status" }
  | {
      kind?: "action";
      active?: boolean;
      badge?: number;
      disabled?: boolean;
      onActivate: () => void;
    }
);

// SAFETY: Before the host supplies preferences, absent fields retain the existing menu defaults.
const EMPTY_SETTINGS = {} as UiSettings;

type CompactMenuView = CompactSessionMenuView | "panels" | "layout" | "sharing" | "view";
type MenuSelectEvent = CustomEvent<{ item: { value?: string } }>;

const COMPACT_MENU_VIEW_BY_VALUE: Record<string, CompactMenuView> = {
  "compact:open-layout": "layout",
  "compact:open-panels": "panels",
  "compact:open-sharing": "sharing",
  "compact:open-view": "view",
};

export type ChatHeaderSessionMenuProps = {
  session: SessionMenuData;
  worktreePath: string | null;
  onboarding: boolean;
  preferencesBrowserOnly: boolean;
  compact: boolean;
  bubbleModeEnabled: boolean;
  mainKey: string;
  copyMarkdownAllowed: boolean;
  splitAllowed: boolean;
  settings: UiSettings;
  panelActions: HeaderMenuQuickAction[];
  layoutActions: HeaderMenuQuickAction[];
  sessionActions: HeaderMenuQuickAction[];
  boardWidgetMenu?: BoardWidgetPageMenu;
  sharing: ChatSessionSharingProps | null;
  groups: readonly string[];
  currentOwner: SessionCreatedActor | null;
  actionDisabledReasons: Partial<Record<HeaderMenuActionKind, string>>;
  forkDisabled: boolean;
  forkFromLastCompleted: boolean;
  archiveAllowed: boolean;
  archiveShortcut: boolean;
  deleteAllowed: boolean;
  onOpen: () => void;
  onOpenCommandPalette: () => void;
  onSettingsChange: (patch: Partial<UiSettings>) => void;
  onAction: (action: HeaderMenuAction) => void;
};
export function ChatHeaderSessionMenuContent(
  props: ChatHeaderSessionMenuProps,
  host: SolidBridgeElement<ChatHeaderSessionMenuProps>,
) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const managementHost = useSessionMenuControllers(
    host,
    useOptionalApplication(),
    () => setRevision((value) => value + 1),
    () => {
      revision();
      return Object.values(props);
    },
  );
  const [compactView, setCompactView] = createSignal<CompactMenuView>("root");
  const managementActions = new SessionMenuActions(
    managementHost,
    () => ({
      session: props.session,
      selectionCount: 1,
      compact: props.compact,
      navigationAllowed: true,
      copyMarkdownAllowed: props.copyMarkdownAllowed,
      splitAllowed: props.splitAllowed,
      renderOpenInExtra: (inline) =>
        renderHeaderTerminalAction(inline, props.actionDisabledReasons["continue-in-terminal"]),
      disabled: false,
      actionDisabledReasons: props.actionDisabledReasons,
      forkDisabled: props.forkDisabled,
      forkFromLastCompleted: props.forkFromLastCompleted,
      archiveAllowed: props.archiveAllowed,
      archiveShortcut: props.archiveShortcut,
      deleteAllowed: props.deleteAllowed,
      groups: props.groups,
      currentOwner: props.currentOwner,
      worktreePath: props.worktreePath,
    }),
    (action) => props.onAction(action),
    () => {
      const dropdown = host.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
      if (dropdown) {
        dropdown.open = false;
      }
    },
  );
  const handleSelect = (event: MenuSelectEvent) => {
    const value = event.detail.item.value;
    if (!value) {
      return;
    }
    if (value.startsWith("board-widget:")) {
      props.boardWidgetMenu?.onSelect(value.slice("board-widget:".length));
      return;
    }
    const managementView = compactSessionMenuViewForValue(value);
    const nextView = managementView ?? COMPACT_MENU_VIEW_BY_VALUE[value];
    if (nextView) {
      event.preventDefault();
      setCompactView(nextView);
      if (managementView) {
        managementActions.prepareCompactView(managementView);
      } else if (nextView === "sharing" && !props.sharing?.openDisabledReason) {
        props.sharing?.onOpen();
      }
      onSettled(() => managementActions.focusCurrentView());
      return;
    }
    if (value === "open-command-palette") {
      props.onOpenCommandPalette();
      return;
    }
    if (value.startsWith("quick:")) {
      const [, group, id] = value.split(":");
      const actions =
        group === "panels"
          ? props.panelActions
          : group === "session"
            ? props.sessionActions
            : props.layoutActions;
      const action = actions.find((candidate) => candidate.id === id);
      if (action && action.kind !== "status" && !action.disabled) {
        action.onActivate();
      }
      return;
    }
    if (value.startsWith("view:")) {
      event.preventDefault();
      if (props.onboarding) {
        return;
      }
      const setting = value.slice("view:".length);
      if (setting === "reasoning") {
        props.onSettingsChange({ chatShowThinking: !props.settings.chatShowThinking });
      } else if (setting === "tool-calls") {
        props.onSettingsChange({ chatShowToolCalls: !props.settings.chatShowToolCalls });
      } else if (setting === "commentary") {
        props.onSettingsChange({
          chatPersistCommentary: props.settings.chatPersistCommentary === false,
        });
      } else if (
        setting === "speech-bubbles" &&
        props.bubbleModeEnabled &&
        props.session.target?.key
      ) {
        const sessionKey = props.session.target.key;
        props.onSettingsChange(
          setChatBubbleMode(
            props.settings,
            sessionKey,
            !isChatBubbleMode(props.settings, sessionKey, props.bubbleModeEnabled, props.mainKey),
          ),
        );
      }
      return;
    }
    if (
      value.startsWith("visibility:") ||
      value.startsWith("member:") ||
      value.startsWith("public:")
    ) {
      if (props.sharing) {
        selectChatSessionSharingItem(props.sharing, value);
      }
      return;
    }
    if (managementActions.handleSelect(value)) {
      event.preventDefault();
      return;
    }
    if (value === "continue-in-terminal" && !props.actionDisabledReasons[value]) {
      const dropdown = host.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
      if (dropdown) {
        dropdown.open = false;
      }
      props.onAction({ kind: value });
    }
  };
  function QuickActionLabel(item: { action: HeaderMenuQuickAction }) {
    return (
      <span class="session-menu__text">
        {item.action.label}
        <Show when={item.action.description}>
          <span class="session-menu__description">{item.action.description}</span>
        </Show>
      </span>
    );
  }
  function QuickActionItems(items: {
    group: "panels" | "layout" | "session";
    actions: HeaderMenuQuickAction[];
    inline?: boolean;
  }) {
    return (
      <For each={items.actions} keyed={(action) => action.id}>
        {(action) => {
          const activeAction = () => {
            const value = action();
            return value.kind === "status" ? null : value;
          };
          return (
            <Show
              when={activeAction()}
              fallback={
                <div
                  slot={items.inline ? undefined : "submenu"}
                  class="session-menu__status"
                  data-menu-status={action().id}
                  role="note"
                >
                  <span class="session-menu__check" aria-hidden="true">
                    <LitContent value={action().icon} />
                  </span>
                  <QuickActionLabel action={action()} />
                </div>
              }
            >
              {(command) => (
                <wa-dropdown-item
                  slot={items.inline ? undefined : "submenu"}
                  class="session-menu__item"
                  value={`quick:${items.group}:${command().id}`}
                  type={command().active === undefined ? undefined : "checkbox"}
                  prop:checked={command().active ?? false}
                  disabled={command().disabled}
                  variant={command().variant}
                >
                  <span slot="icon" class="session-menu__icon" aria-hidden="true">
                    <LitContent value={command().icon} />
                  </span>
                  <QuickActionLabel action={command()} />
                  <Show when={typeof command().badge === "number" && (command().badge ?? 0) > 0}>
                    <span slot="details" class="session-menu__sub">
                      {command().badge}
                    </span>
                  </Show>
                </wa-dropdown-item>
              )}
            </Show>
          );
        }}
      </For>
    );
  }
  function MenuSubmenu(menu: { group: "panels" | "layout" | "view" }) {
    const actions = () => (menu.group === "panels" ? props.panelActions : props.layoutActions);
    const label = () =>
      t(
        menu.group === "view"
          ? "chat.view.menu"
          : menu.group === "panels"
            ? "chat.sessionHeader.panels"
            : "chat.sessionHeader.layout",
      );
    const iconName = () =>
      menu.group === "view" ? "eye" : menu.group === "panels" ? "panelRightOpen" : "columns2";
    const icon = () => icons[iconName()];
    return (
      <Show when={menu.group === "view" || actions().length > 0}>
        <Show
          when={props.compact}
          fallback={
            <wa-dropdown-item class="session-menu__item">
              <span slot="icon" class="session-menu__icon" aria-hidden="true">
                <Icon name={iconName()} />
              </span>
              <span class="session-menu__text">{label()}</span>
              <Show
                when={menu.group === "view"}
                fallback={
                  <QuickActionItems
                    group={menu.group === "panels" ? "panels" : "layout"}
                    actions={actions()}
                  />
                }
              >
                <ViewSubmenu />
              </Show>
            </wa-dropdown-item>
          }
        >
          <LitContent
            value={renderCompactSessionMenuNavigationItem({
              value: `compact:open-${menu.group}`,
              label: label(),
              icon: icon(),
            })}
          />
        </Show>
      </Show>
    );
  }
  function ViewItem(item: { value: string; label: string; checked: boolean; inline?: boolean }) {
    return (
      <wa-dropdown-item
        slot={item.inline ? undefined : "submenu"}
        class="session-menu__item"
        type="checkbox"
        value={`view:${item.value}`}
        prop:checked={item.checked}
        disabled={props.onboarding}
        title={props.onboarding ? t("chat.onboardingDisabled") : undefined}
      >
        <span class="session-menu__text">{item.label}</span>
      </wa-dropdown-item>
    );
  }
  function ViewSubmenu(view: { inline?: boolean }) {
    return (
      <>
        <ViewItem
          inline={view.inline}
          value="reasoning"
          label={t("chat.view.reasoning")}
          checked={!props.onboarding && props.settings.chatShowThinking}
        />
        <ViewItem
          inline={view.inline}
          value="tool-calls"
          label={t("chat.view.toolCalls")}
          checked={props.onboarding || props.settings.chatShowToolCalls}
        />
        <ViewItem
          inline={view.inline}
          value="commentary"
          label={t("chat.view.commentary")}
          checked={props.settings.chatPersistCommentary !== false}
        />
        <Show when={props.bubbleModeEnabled}>
          <ViewItem
            inline={view.inline}
            value="speech-bubbles"
            label={t("chat.view.speechBubbles")}
            checked={isChatBubbleMode(
              props.settings,
              props.session.target?.key ?? "",
              true,
              props.mainKey,
            )}
          />
        </Show>
        <Show when={props.preferencesBrowserOnly}>
          <div slot={view.inline ? undefined : "submenu"} class="session-menu__info" role="note">
            {t("quickSettings.personal.browserOnly")}
          </div>
        </Show>
      </>
    );
  }
  function renderCompactView() {
    const view = compactView();
    if (
      view === "root" ||
      view === "open-in" ||
      view === "copy" ||
      view === "assign-owner" ||
      view === "icon" ||
      view === "group" ||
      view === "snooze" ||
      view === "advanced" ||
      view === "archive"
    ) {
      return (
        <LitContent
          value={(revision(), i18nRevision(), managementActions.renderCompactView(view))}
        />
      );
    }
    const body = (
      <>
        {view === "panels" ? (
          <QuickActionItems group="panels" actions={props.panelActions} inline />
        ) : view === "layout" ? (
          <QuickActionItems group="layout" actions={props.layoutActions} inline />
        ) : view === "sharing" && props.sharing ? (
          <ChatSessionSharing {...props.sharing} inline />
        ) : (
          <ViewSubmenu inline />
        )}
      </>
    );
    return (
      <>
        <wa-dropdown-item class="session-menu__item session-menu__back" value="compact:back">
          <span slot="icon" class="session-menu__icon" aria-hidden="true">
            <Icon name="arrowLeft" />
          </span>
          <span class="session-menu__text">{t("common.back")}</span>
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator" />
        {body}
      </>
    );
  }
  function RootView() {
    return (
      <>
        {props.compact ? (
          <>
            <wa-dropdown-item class="session-menu__item" value="open-command-palette">
              <span slot="icon" class="session-menu__icon" aria-hidden="true">
                <Icon name="search" />
              </span>
              <span class="session-menu__text">{t("chat.openCommandPalette")}</span>
            </wa-dropdown-item>
            <div class="session-menu__separator" role="separator" />
          </>
        ) : undefined}
        {props.boardWidgetMenu ? (
          <>
            <div class="board-widget__page-menu-heading">
              <strong>
                {props.boardWidgetMenu.widget.title || props.boardWidgetMenu.widget.name}
              </strong>
            </div>
            <LitContent
              value={
                (i18nRevision(),
                renderBoardGrantedCapabilities(props.boardWidgetMenu.widget, "details"))
              }
            />
            {props.boardWidgetMenu.canMutate ? (
              <LitContent
                value={
                  (i18nRevision(),
                  renderBoardWidgetMenuItems({
                    widget: props.boardWidgetMenu.widget,
                    tabs: props.boardWidgetMenu.tabs,
                    disabled: false,
                    prefix: "board-widget:",
                  }))
                }
              />
            ) : undefined}
            <div class="session-menu__separator" role="separator" />
          </>
        ) : undefined}
        <MenuSubmenu group="panels" />
        <MenuSubmenu group="layout" />
        {props.compact &&
        props.sharing?.session &&
        canManageChatSessionSharing(props.sharing.session) ? (
          <LitContent
            value={renderCompactSessionMenuNavigationItem({
              value: "compact:open-sharing",
              label: t("chat.sessionSharing.menu"),
              icon: icons.users,
              disabled: Boolean(props.sharing.openDisabledReason),
            })}
          />
        ) : undefined}
        <MenuSubmenu group="view" />
        <div class="session-menu__separator" role="separator" />
        <LitContent
          value={(revision(), i18nRevision(), managementActions.renderPrimaryActions())}
        />
        <div class="session-menu__separator" role="separator" />
        <LitContent
          value={(revision(), i18nRevision(), managementActions.renderOrganizationActions())}
        />
        <QuickActionItems group="session" actions={props.sessionActions} inline />
        <div class="session-menu__separator" role="separator" />
        <LitContent
          value={(revision(), i18nRevision(), managementActions.renderAdvancedAction())}
        />
      </>
    );
  }
  const handleShow = () => {
    setCompactView("root");
    managementActions.loadOwners();
    props.onOpen();
  };
  function render() {
    const menuLabel = () => t("chat.sidebar.sessionMenu", { session: props.session.label });
    return (
      <wa-dropdown
        class={[
          "session-menu chat-header-session-menu",
          {
            "session-menu--compact": props.compact,
            "chat-header-session-menu--compact": props.compact,
            "chat-header-session-menu--compact-sharing":
              props.compact && compactView() === "sharing",
          },
        ]}
        placement="bottom-end"
        aria-label={menuLabel()}
        onKeyDown={(event: KeyboardEvent) => {
          if (!managementActions.handleKeydown(event)) {
            activateMenuShortcut(host, event);
          }
        }}
        onWa-show={handleShow}
        onWa-after-hide={managementActions.advanced.close}
        onWa-select={handleSelect}
      >
        <button
          slot="trigger"
          class="btn btn--ghost btn--icon chat-icon-btn chat-header-session-menu__trigger"
          type="button"
          aria-label={menuLabel()}
          aria-haspopup="menu"
        >
          <Icon name="moreHorizontal" />
        </button>
        <Show when={props.compact && compactView() !== "root"} fallback={<RootView />}>
          <>{renderCompactView()}</>
        </Show>
      </wa-dropdown>
    );
  }
  return render();
}
export const ChatHeaderSessionMenu = defineSolidBridge<ChatHeaderSessionMenuProps>(
  "openclaw-chat-header-session-menu",
  ChatHeaderSessionMenuContent,
  {
    properties: {
      session: { default: EMPTY_SESSION_MENU_DATA, attribute: false },
      worktreePath: { default: null, attribute: false },
      onboarding: { default: false, attribute: false },
      preferencesBrowserOnly: { default: false, attribute: false },
      compact: { default: false, attribute: false },
      bubbleModeEnabled: { default: false, attribute: false },
      mainKey: { default: "main", attribute: false },
      copyMarkdownAllowed: { default: false, attribute: false },
      splitAllowed: { default: false, attribute: false },
      settings: { default: EMPTY_SETTINGS, attribute: false },
      panelActions: { default: [], attribute: false },
      layoutActions: { default: [], attribute: false },
      sessionActions: { default: [], attribute: false },
      boardWidgetMenu: { default: undefined, attribute: false },
      sharing: { default: null, attribute: false },
      groups: { default: [], attribute: false },
      currentOwner: { default: null, attribute: false },
      actionDisabledReasons: { default: {}, attribute: false },
      forkDisabled: { default: false, attribute: false },
      forkFromLastCompleted: { default: false, attribute: false },
      archiveAllowed: { default: false, attribute: false },
      archiveShortcut: { default: false, attribute: false },
      deleteAllowed: { default: false, attribute: false },
      onOpen: { default: () => {}, attribute: false },
      onOpenCommandPalette: { default: () => {}, attribute: false },
      onSettingsChange: { default: () => {}, attribute: false },
      onAction: { default: () => {}, attribute: false },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-header-session-menu": SolidBridgeElement<ChatHeaderSessionMenuProps>;
  }
}
