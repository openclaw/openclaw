import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, merge, onCleanup, onSettled } from "solid-js";
import type { UiSettings } from "../../../app/settings.ts";
import { BoardGrantedCapabilities } from "../../../components/board/board-widget-capabilities.solid.tsx";
import type { BoardWidgetPageMenu } from "../../../components/board/board-widget-cell-options.ts";
import { boardWidgetMenuEntries } from "../../../components/board/board-widget-menu.tsx";
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
import { useSessionMenuEntries } from "../../../components/session-menu-view.tsx";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import {
  Menu,
  type MenuEntry,
  type MenuItem,
  type MenuHandle,
} from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { SessionCreatedActor } from "../../../lib/session-owner.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { isChatBubbleMode, setChatBubbleMode } from "../chat-bubble-mode.ts";
import { useChatQuickActionEntries, type HeaderMenuSessionAction } from "./chat-quick-action.tsx";
import {
  canManageChatSessionSharing,
  useChatSessionSharingMenu,
  selectChatSessionSharingItem,
  type ChatSessionSharingProps,
} from "./chat-session-sharing.solid.tsx";

export type HeaderMenuAction =
  | SessionManagementAction
  | { kind: "continue-in-terminal" }
  | { kind: "stop-cloud-worker" }
  | { kind: "plugin"; id: string };
export type HeaderMenuActionKind = HeaderMenuAction["kind"];
export type { HeaderMenuQuickAction, HeaderMenuSessionAction } from "./chat-quick-action.tsx";

type CompactMenuView = CompactSessionMenuView | "sharing" | "view";
type HeaderMenuProps = {
  session: SessionMenuData;
  worktreePath: string | null;
  onboarding: boolean;
  preferencesBrowserOnly: boolean;
  compact: boolean;
  prewarm?: boolean;
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
  sessionActions: HeaderMenuSessionAction[];
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
  onOpenDetails?: (source: HTMLElement) => void;
  onSettingsChange: (patch: Partial<UiSettings>) => void;
  onAction: (action: HeaderMenuAction) => void;
};

const COMPACT_MENU_VIEW_BY_VALUE: Record<string, CompactMenuView> = {
  "compact:open-sharing": "sharing",
  "compact:open-view": "view",
};

const VIEW_SETTINGS = [
  ["reasoning", "chatShowThinking", "chat.view.reasoning", false],
  ["tool-calls", "chatShowToolCalls", "chat.view.toolCalls", true],
  ["commentary", "chatPersistCommentary", "chat.view.commentary", undefined],
] as const;

type HeaderMenuMethods = { openMenu(): boolean };
const openMenus = new WeakMap<HTMLElement, () => boolean>();
let nextMenuId = 0;

function ChatHeaderSessionMenuContent(
  props: HeaderMenuProps,
  host: SolidBridgeElement<HeaderMenuProps, HeaderMenuMethods>,
) {
  const menuId = `chat-header-session-${++nextMenuId}`;
  const [compactView, setCompactView] = createSignal<CompactMenuView>("root");
  let menu: MenuHandle | undefined;
  const quickActions = useChatQuickActionEntries(() => props.sessionActions, false, "quick:");
  const state = merge(props, { selectionCount: 1, navigationAllowed: true, disabled: false });
  const readState = () => state;
  const close = () => {
    menu?.close();
  };
  const actions = new SessionMenuActions(
    host,
    readState,
    (action) => props.onAction(action),
    close,
  );
  const view = useSessionMenuEntries(actions, readState, {
    openInExtra: () => [
      {
        id: "continue-in-terminal",
        label: t("chat.sessionHeader.continueInTerminal.action"),
        class: "session-menu__item",
        labelClass: "session-menu__text",
        disabled: Boolean(props.actionDisabledReasons["continue-in-terminal"]),
        attributes: { title: props.actionDisabledReasons["continue-in-terminal"] },
        icon: (
          <span class="session-menu__icon" aria-hidden="true">
            <Icon name="terminal" />
          </span>
        ),
      },
    ],
  });
  const sharing = useChatSessionSharingMenu(
    merge(
      {
        session: undefined,
        state: undefined,
        onOpen: () => {},
        onVisibilityChange: () => {},
        onMemberChange: () => {},
      },
      () => props.sharing ?? {},
    ),
  );
  openMenus.set(host, () => menu?.open() ?? false);
  const shortcut = (event: KeyboardEvent) => {
    if (!actions.handleKeydown(event, view.appearance)) {
      activateMenuShortcut(host, event);
    }
  };
  onCleanup(() => {
    openMenus.delete(host);
    menu?.overlay.surface.removeEventListener("keydown", shortcut, true);
  });
  const content = (id: string, value: JSX.Element): MenuEntry => ({
    kind: "content",
    id,
    content: value,
  });
  const separator = (id: string) =>
    content(id, <div class="session-menu__separator" role="separator" />);
  // Replacing a divider can move adjacent branches and close their native popovers.
  const paletteDivider = separator("palette-divider");
  const boardDivider = separator("board-divider");
  const viewDivider = separator("view-divider");
  const primaryDivider = separator("primary-divider");
  const organizationDivider = separator("organization-divider");
  const browserOnlyInfo = content(
    "browser-only",
    <div class="session-menu__info" role="note">
      {t("quickSettings.personal.browserOnly")}
    </div>,
  );
  function viewOptions(): MenuEntry[] {
    return [
      ...VIEW_SETTINGS.map(([value, key, label, onboarding]) => ({
        id: `view:${value}`,
        label: t(label),
        class: "session-menu__item",
        labelClass: "session-menu__text",
        type: "checkbox" as const,
        checked:
          props.onboarding && onboarding !== undefined ? onboarding : props.settings[key] !== false,
        disabled: props.onboarding,
        attributes: { title: props.onboarding ? t("chat.onboardingDisabled") : undefined },
        closeOnSelect: false,
      })),
      ...(props.bubbleModeEnabled
        ? [
            {
              id: "view:speech-bubbles",
              label: t("chat.view.speechBubbles"),
              class: "session-menu__item",
              labelClass: "session-menu__text",
              type: "checkbox" as const,
              checked: isChatBubbleMode(
                props.settings,
                props.session.target?.key ?? "",
                true,
                props.mainKey,
              ),
              disabled: props.onboarding,
              attributes: { title: props.onboarding ? t("chat.onboardingDisabled") : undefined },
              closeOnSelect: false,
            },
          ]
        : []),
      ...(props.preferencesBrowserOnly ? [browserOnlyInfo] : []),
    ];
  }
  function group(
    viewName: "view" | "sharing",
    label: string,
    icon: IconName,
    disabled = false,
  ): MenuItem {
    return {
      id: props.compact ? `compact:open-${viewName}` : `submenu:${viewName}`,
      label,
      labelClass: "session-menu__text",
      class: "session-menu__item",
      disabled,
      icon: (
        <span class="session-menu__icon" aria-hidden="true">
          <Icon name={icon} />
        </span>
      ),
      details: props.compact ? (
        <span class="session-menu__icon session-menu__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      ) : undefined,
      children: props.compact
        ? undefined
        : viewName === "sharing"
          ? sharing.items()
          : viewOptions(),
      closeOnSelect: false,
    };
  }
  function root(): MenuEntry[] {
    const board = props.boardWidgetMenu;
    return [
      {
        id: "open-command-palette",
        label: t("chat.openCommandPalette"),
        class: "session-menu__item",
        labelClass: "session-menu__text",
        icon: (
          <span class="session-menu__icon" aria-hidden="true">
            <Icon name="search" />
          </span>
        ),
      },
      ...(props.onOpenDetails
        ? [
            {
              id: "session-details",
              label: t("chat.sessionDetails.menu"),
              class: "session-menu__item",
              labelClass: "session-menu__text",
              icon: (
                <span class="session-menu__icon" aria-hidden="true">
                  <Icon name="listChecks" />
                </span>
              ),
            },
          ]
        : []),
      paletteDivider,
      ...(board
        ? [
            content(
              "board-heading",
              <>
                <div class="board-widget__page-menu-heading">
                  <strong>{board.widget.title || board.widget.name}</strong>
                </div>
                <BoardGrantedCapabilities widget={board.widget} presentation="details" />
              </>,
            ),
            ...(board.canMutate
              ? boardWidgetMenuEntries({
                  widget: board.widget,
                  tabs: board.tabs,
                  disabled: false,
                }).map((entry) => Object.assign(entry, { id: `board-widget:${entry.id}` }))
              : []),
            boardDivider,
          ]
        : []),
      ...(props.compact &&
      props.sharing?.session &&
      canManageChatSessionSharing(props.sharing.session)
        ? [
            group(
              "sharing",
              t("chat.sessionSharing.menu"),
              "users",
              Boolean(props.sharing.openDisabledReason),
            ),
          ]
        : []),
      group("view", t("chat.view.menu"), "eye"),
      viewDivider,
      ...view.primary(),
      primaryDivider,
      ...view.organization(),
      ...quickActions(),
      organizationDivider,
      ...view.advanced(),
    ];
  }
  const backDivider = separator("back-divider");
  const items = createMemo(
    (): MenuEntry[] => {
      const current = compactView();
      if (!props.compact || current === "root") {
        return root();
      }
      if (current !== "sharing" && current !== "view") {
        return view.compact(current);
      }
      return [
        {
          id: "compact:back",
          label: t("common.back"),
          class: "session-menu__item session-menu__back",
          icon: (
            <span class="session-menu__icon" aria-hidden="true">
              <Icon name="arrowLeft" />
            </span>
          ),
          closeOnSelect: false,
        },
        backDivider,
        ...(current === "sharing" && props.sharing ? sharing.items() : viewOptions()),
      ];
    },
    { lazy: true },
  );
  function select(item: MenuItem, event: CustomEvent<MenuItem>) {
    const value = item.id;
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
    if (value === "session-details") {
      event.preventDefault();
      close();
      const trigger = menu?.overlay.trigger;
      if (trigger) {
        props.onOpenDetails?.(trigger);
      }
      return;
    }
    if (value === "open-command-palette") {
      close();
      props.onOpenCommandPalette();
      return;
    }
    if (value.startsWith("quick:")) {
      const action = props.sessionActions.find(
        (candidate) => candidate.id === value.slice("quick:".length),
      );
      if (action && !action.disabled) {
        close();
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
      const option = VIEW_SETTINGS.find(([id]) => id === setting);
      if (option) {
        props.onSettingsChange({ [option[1]]: props.settings[option[1]] === false });
      } else if (
        setting === "speech-bubbles" &&
        props.bubbleModeEnabled &&
        props.session.target?.key
      ) {
        props.onSettingsChange(
          setChatBubbleMode(
            props.settings,
            props.session.target.key,
            !isChatBubbleMode(
              props.settings,
              props.session.target.key,
              props.bubbleModeEnabled,
              props.mainKey,
            ),
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
  }
  const label = () => t("chat.sidebar.sessionMenu", { session: props.session.label });
  return (
    <Menu
      id={menuId}
      lazy
      prewarm={props.prewarm && !props.compact}
      class={`session-menu chat-header-session-menu${props.compact ? " session-menu--compact chat-header-session-menu--compact" : ""}${props.compact && compactView() === "sharing" ? " chat-header-session-menu--compact-sharing" : ""}`}
      panelClass="chat-header-session-menu__panel"
      placement="bottom-end"
      label={label()}
      triggerClass="btn btn--ghost btn--icon chat-icon-btn chat-header-session-menu__trigger"
      trigger={<Icon name="moreHorizontal" />}
      items={items()}
      onSelect={select}
      ref={(handle) => {
        menu = handle;
        handle.overlay.surface.addEventListener("keydown", shortcut, true);
      }}
      onEscape={(event) => actions.handleKeydown(event, view.appearance)}
      onOpenChange={(open) => {
        if (open) {
          actions.loadOwners();
          props.onOpen();
        } else {
          setCompactView("root");
          actions.advanced.close();
        }
      }}
    />
  );
}

defineSolidBridge<HeaderMenuProps, HeaderMenuMethods>(
  "openclaw-chat-header-session-menu",
  ChatHeaderSessionMenuContent,
  {
    methods: { openMenu: (host) => openMenus.get(host)?.() ?? false },
    properties: {
      session: { default: EMPTY_SESSION_MENU_DATA, attribute: false },
      worktreePath: { default: null, attribute: false },
      onboarding: { default: false, attribute: false },
      preferencesBrowserOnly: { default: false, attribute: false },
      compact: { default: false, attribute: false },
      prewarm: { default: false, attribute: false },
      bubbleModeEnabled: { default: false, attribute: false },
      mainKey: { default: "main", attribute: false },
      copyMarkdownAllowed: { default: false, attribute: false },
      splitAllowed: { default: false, attribute: false },
      settings: {
        default: { chatShowThinking: false, chatShowToolCalls: false },
        attribute: false,
      },
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
      onOpenDetails: { default: undefined, attribute: false },
      onSettingsChange: { default: () => {}, attribute: false },
      onAction: { default: () => {}, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-header-session-menu": SolidBridgeElement<HeaderMenuProps, HeaderMenuMethods>;
  }
}
