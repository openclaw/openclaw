import { createSignal, For, merge, onSettled, Show } from "solid-js";
import type { UiSettings } from "../../../app/settings.ts";
import { BoardGrantedCapabilities } from "../../../components/board/board-widget-capabilities.solid.tsx";
import { BoardWidgetMenuItems } from "../../../components/board/board-widget-cell-render.solid.tsx";
import type { BoardWidgetPageMenu } from "../../../components/board/board-widget-cell-render.ts";
import { activateMenuShortcut } from "../../../components/menu-shortcuts.ts";
import {
  EMPTY_SESSION_MENU_DATA,
  SessionMenuActions,
  type SessionManagementAction,
  type SessionMenuData,
} from "../../../components/session-menu-actions.ts";
import {
  compactSessionMenuViewForValue,
  type CompactSessionMenuView,
} from "../../../components/session-menu-compact.ts";
import { useSessionMenuControllers } from "../../../components/session-menu-controllers.ts";
import { useSessionMenuView } from "../../../components/session-menu-view.tsx";
import type { SessionCreatedActor } from "../../../components/session-owner-chip.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { LitContent, type LegacyTemplateResult } from "../../../lit/solid-content.tsx";
import { isChatBubbleMode, setChatBubbleMode } from "../chat-bubble-mode.ts";
import {
  canManageChatSessionSharing,
  ChatSessionSharing,
  selectChatSessionSharingItem,
  type ChatSessionSharingProps,
} from "./chat-session-sharing.solid.tsx";

export type HeaderMenuAction =
  | SessionManagementAction
  | { kind: "continue-in-terminal" }
  | { kind: "stop-cloud-worker" }
  | { kind: "plugin"; id: string };
export type HeaderMenuActionKind = HeaderMenuAction["kind"];
export type HeaderMenuQuickAction = {
  id: string;
  label: string;
  icon: LegacyTemplateResult;
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

type CompactMenuView = CompactSessionMenuView | "panels" | "layout" | "sharing" | "view";
type HeaderMenuProps = {
  session: SessionMenuData;
  worktreePath: string | null;
  onboarding: boolean;
  preferencesBrowserOnly: boolean;
  compact: boolean;
  bubbleModeEnabled: boolean;
  mainKey: string;
  copyMarkdownAllowed: boolean;
  splitAllowed: boolean;
  settings: Pick<
    UiSettings,
    | "chatShowThinking"
    | "chatShowToolCalls"
    | "chatPersistCommentary"
    | "chatBubbleSessionKeys"
    | "chatBubbleDisabledSessionKeys"
  >;
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

const COMPACT_MENU_VIEW_BY_VALUE: Record<string, CompactMenuView> = {
  "compact:open-layout": "layout",
  "compact:open-panels": "panels",
  "compact:open-sharing": "sharing",
  "compact:open-view": "view",
};

function ChatHeaderSessionMenuContent(
  props: HeaderMenuProps,
  host: SolidBridgeElement<HeaderMenuProps>,
) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [compactView, setCompactView] = createSignal<CompactMenuView>("root");
  let dropdown: HTMLElement & { open: boolean };
  const state = merge(props, { selectionCount: 1, navigationAllowed: true, disabled: false });
  const readState = () => state;
  const controllerHost = useSessionMenuControllers(
    host,
    useOptionalApplication(),
    () => setRevision((value) => value + 1),
    () => {
      revision();
      return Object.values(props);
    },
  );
  const close = () => {
    dropdown.open = false;
  };
  const actions = new SessionMenuActions(
    controllerHost,
    readState,
    (action) => props.onAction(action),
    close,
  );
  const view = useSessionMenuView(host, actions, readState, revision, {
    renderOpenInExtra: (inline) => (
      <wa-dropdown-item
        slot={inline ? undefined : "submenu"}
        class="session-menu__item"
        value="continue-in-terminal"
        prop:disabled={Boolean(props.actionDisabledReasons["continue-in-terminal"])}
        title={props.actionDisabledReasons["continue-in-terminal"]}
      >
        <span slot="icon" class="session-menu__icon" aria-hidden="true">
          <Icon name="terminal" />
        </span>
        <span class="session-menu__text">{t("chat.sessionHeader.continueInTerminal.action")}</span>
      </wa-dropdown-item>
    ),
  });
  const handleSelect = (event: CustomEvent<{ item: { value?: string } }>) => {
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
      if (managementView === "icon") {
        view.appearance.prepare();
      } else if (nextView === "sharing" && !props.sharing?.openDisabledReason) {
        props.sharing?.onOpen();
      }
      onSettled(() => actions.focusCurrentView());
      return;
    }
    if (value === "open-command-palette") {
      props.onOpenCommandPalette();
      return;
    }
    if (value.startsWith("quick:")) {
      const [, group, id] = value.split(":");
      const entries =
        group === "panels"
          ? props.panelActions
          : group === "session"
            ? props.sessionActions
            : props.layoutActions;
      const action = entries.find((candidate) => candidate.id === id);
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
    if (actions.handleSelect(value)) {
      event.preventDefault();
      return;
    }
    if (value === "continue-in-terminal" && !props.actionDisabledReasons[value]) {
      close();
      props.onAction({ kind: value });
    }
  };
  const QuickActions = (input: {
    group: "panels" | "layout" | "session";
    entries: HeaderMenuQuickAction[];
    inline?: boolean;
  }) => (
    <For each={input.entries}>
      {(action) => {
        const label = (
          <span class="session-menu__text">
            {action.label}
            {action.description ? (
              <span class="session-menu__description">{action.description}</span>
            ) : undefined}
          </span>
        );
        return action.kind === "status" ? (
          <div
            slot={input.inline ? undefined : "submenu"}
            class="session-menu__status"
            data-menu-status={action.id}
            role="note"
          >
            <span class="session-menu__check" aria-hidden="true">
              <LitContent value={action.icon} />
            </span>
            {label}
          </div>
        ) : (
          <wa-dropdown-item
            slot={input.inline ? undefined : "submenu"}
            class="session-menu__item"
            value={`quick:${input.group}:${action.id}`}
            type={action.active === undefined ? undefined : "checkbox"}
            prop:checked={action.active ?? false}
            prop:disabled={action.disabled}
            variant={action.variant}
          >
            <span slot="icon" class="session-menu__icon" aria-hidden="true">
              <LitContent value={action.icon} />
            </span>
            {label}
            {typeof action.badge === "number" && action.badge > 0 ? (
              <span slot="details" class="session-menu__sub">
                {action.badge}
              </span>
            ) : undefined}
          </wa-dropdown-item>
        );
      }}
    </For>
  );
  const ViewOption = (input: {
    inline?: boolean;
    value: string;
    label: string;
    checked: boolean;
  }) => (
    <wa-dropdown-item
      slot={input.inline ? undefined : "submenu"}
      class="session-menu__item"
      type="checkbox"
      value={`view:${input.value}`}
      prop:checked={input.checked}
      prop:disabled={props.onboarding}
      title={props.onboarding ? t("chat.onboardingDisabled") : undefined}
    >
      <span class="session-menu__text">{input.label}</span>
    </wa-dropdown-item>
  );
  const ViewOptions = (input: { inline?: boolean }) => (
    <>
      <ViewOption
        inline={input.inline}
        value="reasoning"
        label={t("chat.view.reasoning")}
        checked={props.onboarding ? false : props.settings.chatShowThinking}
      />
      <ViewOption
        inline={input.inline}
        value="tool-calls"
        label={t("chat.view.toolCalls")}
        checked={props.onboarding ? true : props.settings.chatShowToolCalls}
      />
      <ViewOption
        inline={input.inline}
        value="commentary"
        label={t("chat.view.commentary")}
        checked={props.settings.chatPersistCommentary !== false}
      />
      {props.bubbleModeEnabled ? (
        <ViewOption
          inline={input.inline}
          value="speech-bubbles"
          label={t("chat.view.speechBubbles")}
          checked={isChatBubbleMode(
            props.settings,
            props.session.target?.key ?? "",
            true,
            props.mainKey,
          )}
        />
      ) : undefined}
      {props.preferencesBrowserOnly ? (
        <div slot={input.inline ? undefined : "submenu"} class="session-menu__info" role="note">
          {t("quickSettings.personal.browserOnly")}
        </div>
      ) : undefined}
    </>
  );
  const Submenu = (input: {
    group: "panels" | "layout" | "view" | "sharing";
    label: string;
    icon: IconName;
    disabled?: boolean;
  }) => (
    <wa-dropdown-item
      class="session-menu__item"
      value={props.compact ? `compact:open-${input.group}` : undefined}
      prop:disabled={input.disabled}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">
        <Icon name={input.icon} />
      </span>
      <span class="session-menu__text">{input.label}</span>
      {props.compact ? (
        <span slot="details" class="session-menu__icon session-menu__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      ) : input.group === "view" ? (
        <ViewOptions />
      ) : (
        <QuickActions
          group={input.group === "panels" ? "panels" : "layout"}
          entries={input.group === "panels" ? props.panelActions : props.layoutActions}
        />
      )}
    </wa-dropdown-item>
  );
  const Compact = () => (
    <Show when={compactView()} keyed>
      {(current) => {
        if (
          current !== "panels" &&
          current !== "layout" &&
          current !== "sharing" &&
          current !== "view"
        ) {
          return <view.Compact view={current} />;
        }
        return (
          <>
            <wa-dropdown-item class="session-menu__item session-menu__back" value="compact:back">
              <span slot="icon" class="session-menu__icon" aria-hidden="true">
                <Icon name="arrowLeft" />
              </span>
              <span class="session-menu__text">{t("common.back")}</span>
            </wa-dropdown-item>
            <div class="session-menu__separator" role="separator" />
            {current === "panels" ? (
              <QuickActions group="panels" entries={props.panelActions} inline />
            ) : current === "layout" ? (
              <QuickActions group="layout" entries={props.layoutActions} inline />
            ) : current === "sharing" && props.sharing ? (
              <ChatSessionSharing {...props.sharing} inline />
            ) : (
              <ViewOptions inline />
            )}
          </>
        );
      }}
    </Show>
  );
  const Root = () => (
    <>
      <wa-dropdown-item class="session-menu__item" value="open-command-palette">
        <span slot="icon" class="session-menu__icon" aria-hidden="true">
          <Icon name="search" />
        </span>
        <span class="session-menu__text">{t("chat.openCommandPalette")}</span>
      </wa-dropdown-item>
      <div class="session-menu__separator" role="separator" />
      <Show when={props.boardWidgetMenu}>
        {(menu) => (
          <>
            <div class="board-widget__page-menu-heading">
              <strong>{menu().widget.title || menu().widget.name}</strong>
            </div>
            <BoardGrantedCapabilities widget={menu().widget} presentation="details" />
            {menu().canMutate ? (
              <BoardWidgetMenuItems
                widget={menu().widget}
                tabs={menu().tabs}
                disabled={false}
                prefix="board-widget:"
              />
            ) : undefined}
            <div class="session-menu__separator" role="separator" />
          </>
        )}
      </Show>
      {props.panelActions.length ? (
        <Submenu group="panels" label={t("chat.sessionHeader.panels")} icon="panelRightOpen" />
      ) : undefined}
      {props.layoutActions.length ? (
        <Submenu group="layout" label={t("chat.sessionHeader.layout")} icon="columns2" />
      ) : undefined}
      {props.compact &&
      props.sharing?.session &&
      canManageChatSessionSharing(props.sharing.session) ? (
        <Submenu
          group="sharing"
          label={t("chat.sessionSharing.menu")}
          icon="users"
          disabled={Boolean(props.sharing.openDisabledReason)}
        />
      ) : undefined}
      <Submenu group="view" label={t("chat.view.menu")} icon="eye" />
      <div class="session-menu__separator" role="separator" />
      <view.Primary />
      <div class="session-menu__separator" role="separator" />
      <view.Organization />
      <QuickActions group="session" entries={props.sessionActions} inline />
      <div class="session-menu__separator" role="separator" />
      <view.Advanced />
    </>
  );
  const menuLabel = () => t("chat.sidebar.sessionMenu", { session: props.session.label });
  return (
    <wa-dropdown
      ref={(element) => {
        dropdown = element;
      }}
      class={[
        "session-menu chat-header-session-menu",
        {
          "session-menu--compact chat-header-session-menu--compact": props.compact,
          "chat-header-session-menu--compact-sharing": props.compact && compactView() === "sharing",
        },
      ]}
      placement="bottom-end"
      aria-label={menuLabel()}
      onKeyDown={(event) => {
        if (!actions.handleKeydown(event, view.appearance)) {
          activateMenuShortcut(host, event);
        }
      }}
      onWa-show={() => {
        setCompactView("root");
        actions.loadOwners();
        props.onOpen();
      }}
      onWa-after-hide={actions.advanced.close}
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
      <Show when={props.compact && compactView() !== "root"} fallback={<Root />}>
        <Compact />
      </Show>
    </wa-dropdown>
  );
}

defineSolidBridge<HeaderMenuProps>(
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
      settings: {
        default: { chatShowThinking: false, chatShowToolCalls: false },
        attribute: false,
      },
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
    "openclaw-chat-header-session-menu": SolidBridgeElement<HeaderMenuProps>;
  }
}
