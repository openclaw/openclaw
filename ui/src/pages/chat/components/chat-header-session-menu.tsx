import type { JSX } from "@solidjs/web";
import {
  createMemo,
  createProjection,
  createSignal,
  flush,
  merge,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import type { UiSettings } from "../../../app/settings.ts";
import { BoardGrantedCapabilities } from "../../../components/board/board-widget-capabilities.solid.tsx";
import type { BoardWidgetPageMenu } from "../../../components/board/board-widget-cell-options.ts";
import { boardWidgetMenuEntries } from "../../../components/board/board-widget-menu.tsx";
import { activateMenuShortcut } from "../../../components/menu-shortcut-activation.ts";
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
import { createSessionOwnerMenu } from "../../../components/session-owner-menu.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import {
  createMenuControls,
  Menu,
  type MenuEntry,
  type MenuItem,
  type MenuHandle,
} from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import type { SessionCreatedActor } from "../../../lib/session-owner.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { isChatBubbleMode, setChatBubbleMode } from "../chat-bubble-mode.ts";
import {
  createMobileHeaderSessionMenu,
  type HeaderSessionMenuMobileHost,
} from "./chat-header-session-menu-mobile.tsx";
import {
  useChatQuickActionEntries,
  type HeaderMenuSessionAction,
  type HeaderMenuQuickAction,
} from "./chat-quick-action.tsx";
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
  /** Pane-local actions before a catalog thread has session management metadata. */
  paneTitle?: string;
  worktreePath: string | null;
  onboarding: boolean;
  preferencesBrowserOnly: boolean;
  compact: boolean;
  mobile?: boolean;
  mobileHost?: HeaderSessionMenuMobileHost;
  mobilePageOpen?: boolean;
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
  viewActions?: HeaderMenuQuickAction[];
  viewContent?: JSX.Element;
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
  liveProps: HeaderMenuProps,
  host: SolidBridgeElement<HeaderMenuProps, HeaderMenuMethods>,
) {
  const menuId = `chat-header-session-${++nextMenuId}`;
  const [compactView, setCompactView] = createSignal<CompactMenuView>("root");
  const [open, setOpen] = createSignal(false);
  const preparation = () => liveProps.prewarm;
  const presented = () => open() || (liveProps.mobilePageOpen ?? false);
  const presentation = createParkedProjection(() => ({ ...liveProps }), presented, preparation);
  const props = createProjection(presentation, {}, { key: "id" });
  const controls = createMenuControls();
  let menu: MenuHandle | undefined;
  let stopShortcut: (() => void) | undefined;
  const quickActions = useChatQuickActionEntries(() => props.sessionActions, false, "quick:");
  const viewActions = useChatQuickActionEntries(() => props.viewActions ?? [], true, "layout:");
  const mobile = () => props.mobile === true && Boolean(props.mobileHost) && !props.boardWidgetMenu;
  const state = merge(props, () => ({
    compact: mobile() || props.compact,
    selectionCount: 1,
    navigationAllowed: true,
    disabled: false,
  }));
  const readState = () => state;
  const close = () => {
    menu?.close();
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
    (action) => untrack(() => props.onAction(action)),
    close,
    createSessionOwnerMenu(presented, preparation),
  );
  const view = useSessionMenuEntries(actions, readState, {
    controls,
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
    controls,
  );
  openMenus.set(host, () => menu?.open() ?? false);
  const shortcut = (event: KeyboardEvent) => {
    if (props.paneTitle !== undefined || !actions.handleKeydown(event, view.appearance)) {
      activateMenuShortcut(menu?.overlay.surface, event);
    }
  };
  onCleanup(() => {
    openMenus.delete(host);
    stopShortcut?.();
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
  const palette = (): MenuItem => ({
    id: "open-command-palette",
    label: t("chat.openCommandPalette"),
    class: "session-menu__item",
    labelClass: "session-menu__text",
    icon: (
      <span class="session-menu__icon" aria-hidden="true">
        <Icon name="search" />
      </span>
    ),
  });
  const mobileMenu = createMobileHeaderSessionMenu({
    view,
    currentOwner: () => props.currentOwner,
    category: () => props.session.category,
    viewOptions,
    palette,
    host: () => props.mobileHost,
    source: () => menu?.overlay.trigger,
    closeMenu: close,
    select: (item) => select(item, new CustomEvent("select", { cancelable: true, detail: item })),
  });
  const browserOnlyInfo = content(
    "browser-only",
    <div class="session-menu__info" role="note">
      {t("quickSettings.personal.browserOnly")}
    </div>,
  );
  function viewOptions(): MenuEntry[] {
    if (props.paneTitle !== undefined) {
      return [...viewActions()];
    }
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
      ...viewActions(),
      ...(props.viewContent ? [content("native-header-actions", props.viewContent)] : []),
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
    if (props.paneTitle !== undefined) {
      return [
        ...quickActions(),
        ...(viewActions().length ? [group("view", t("chat.view.menu"), "eye")] : []),
      ];
    }
    const board = props.boardWidgetMenu;
    return [
      ...(props.mobile === false ? [] : [palette()]),
      ...((props.mobile !== false || board) && props.onOpenDetails
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
      ...(props.mobile === false ? [] : [paletteDivider]),
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
      ...quickActions().filter((entry) => entry.id === "quick:open-split-view"),
      group("view", t("chat.view.menu"), "eye"),
      viewDivider,
      ...view.primary(),
      primaryDivider,
      ...view.organization(),
      ...quickActions().filter((entry) => entry.id !== "quick:open-split-view"),
      organizationDivider,
      ...view.advanced(),
    ];
  }
  const backDivider = separator("back-divider");
  const items = createMemo(
    (): MenuEntry[] => {
      const current = compactView();
      if (mobile()) {
        return current === "snooze" ? view.compact(current) : mobileMenu.root(root());
      }
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
    if (mobile() && mobileMenu.open(value)) {
      event.preventDefault();
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
    if (value.startsWith("layout:")) {
      const action = props.viewActions?.find(
        (candidate) => candidate.id === value.slice("layout:".length),
      );
      if (action && action.kind !== "status" && !action.disabled) {
        // Restore the pane trigger before an action can remove its menu and pane.
        event.preventDefault();
        close();
        void action.onActivate();
      }
      return;
    }
    if (value.startsWith("quick:")) {
      const action = props.sessionActions.find(
        (candidate) => candidate.id === value.slice("quick:".length),
      );
      if (action && !action.disabled) {
        close();
        void action.onActivate();
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
        void selectChatSessionSharingItem(props.sharing, value);
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
  const label = () =>
    t("chat.sidebar.sessionMenu", { session: liveProps.paneTitle ?? liveProps.session.label });
  return (
    <>
      <Show when={!presented()}>
        {(_parked) => {
          onSettled(() => actions.advanced.close());
          return undefined;
        }}
      </Show>
      <Menu
        controls={controls}
        id={menuId}
        lazy
        prewarm={liveProps.prewarm && !liveProps.compact}
        class={[
          "session-menu chat-header-session-menu",
          {
            "session-menu--compact chat-header-session-menu--compact": props.compact || mobile(),
            "chat-header-session-menu--mobile": mobile(),
            "chat-header-session-menu--compact-sharing":
              props.compact && compactView() === "sharing",
          },
        ]}
        panelClass="chat-header-session-menu__panel"
        placement="bottom-end"
        label={label()}
        triggerClass="btn btn--ghost btn--icon chat-icon-btn chat-header-session-menu__trigger"
        trigger={<Icon name="moreHorizontal" />}
        items={items()}
        onSelect={select}
        ref={(handle) => {
          menu = handle;
          stopShortcut = listen(handle.overlay.surface, "keydown", shortcut, true);
        }}
        onEscape={(event) =>
          props.paneTitle === undefined && actions.handleKeydown(event, view.appearance)
        }
        onBeforeShow={() => {
          setOpen(true);
          // Native opening reads the prepared items for validation and initial focus synchronously.
          flush();
        }}
        onOpenChange={(isOpen) => {
          setOpen(isOpen);
          if (isOpen) {
            if (props.paneTitle === undefined) {
              actions.loadOwners();
            }
            props.onOpen();
          } else {
            setCompactView("root");
            if (!mobile()) {
              actions.advanced.close();
            }
          }
        }}
      />
    </>
  );
}

export const ChatHeaderSessionMenu = defineSolidBridge<HeaderMenuProps, HeaderMenuMethods>(
  "openclaw-chat-header-session-menu",
  ChatHeaderSessionMenuContent,
  {
    methods: { openMenu: (host) => openMenus.get(host)?.() ?? false },
    properties: {
      session: { default: EMPTY_SESSION_MENU_DATA, attribute: false },
      paneTitle: { default: undefined, attribute: false },
      worktreePath: { default: null, attribute: false },
      onboarding: { default: false, attribute: false },
      preferencesBrowserOnly: { default: false, attribute: false },
      compact: { default: false, attribute: false },
      mobile: { default: undefined, attribute: false },
      mobileHost: { default: undefined, attribute: false },
      mobilePageOpen: { default: false, attribute: false },
      prewarm: { default: false, attribute: false },
      bubbleModeEnabled: { default: false, attribute: false },
      mainKey: { default: "main", attribute: false },
      copyMarkdownAllowed: { default: false, attribute: false },
      splitAllowed: { default: false, attribute: false },
      settings: {
        default: { chatShowThinking: false, chatShowToolCalls: false },
        attribute: false,
      },
      viewContent: { default: undefined, attribute: false },
      viewActions: { default: undefined, attribute: false },
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
