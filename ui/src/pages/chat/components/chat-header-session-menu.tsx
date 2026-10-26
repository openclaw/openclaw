import type { JSX } from "@solidjs/web";
import { createProjection, createSignal, Errored, lazy, Loading, onSettled } from "solid-js";
import type { UiSettings } from "../../../app/settings.ts";
import type { BoardWidgetPageMenu } from "../../../components/board/board-widget-cell-options.ts";
import type {
  SessionManagementAction,
  SessionMenuData,
} from "../../../components/session-menu-actions.ts";
import type { CompactSessionMenuView } from "../../../components/session-menu-compact.ts";
import { EMPTY_SESSION_MENU_DATA } from "../../../components/session-menu-data.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import {
  createMenuControls,
  Menu,
  type MenuControls,
  type MenuEntry,
  type MenuItem,
  type MenuHandle,
} from "../../../components/solid/menu.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import type { SessionCreatedActor } from "../../../lib/session-owner.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type { HeaderSessionMenuMobileHost } from "./chat-header-session-menu-mobile.tsx";
import type { HeaderMenuSessionAction, HeaderMenuQuickAction } from "./chat-quick-action.tsx";
import type { ChatSessionSharingProps } from "./chat-session-sharing-shared.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

const Content = lazy(() => import("./chat-header-session-menu-content.tsx"), {
  export: "ChatHeaderSessionMenuContent",
});

export type HeaderMenuAction =
  | SessionManagementAction
  | { kind: "continue-in-terminal" }
  | { kind: "stop-cloud-worker" }
  | { kind: "plugin"; id: string };
export type HeaderMenuActionKind = HeaderMenuAction["kind"];
export type { HeaderMenuQuickAction, HeaderMenuSessionAction } from "./chat-quick-action.tsx";

export type CompactMenuView = CompactSessionMenuView | "sharing" | "view";
export type HeaderMenuProps = {
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

type HeaderMenuMethods = {
  openMenu(): boolean;
  readTrigger(): HTMLElement | undefined;
};
type HeaderMenuHandlers = {
  select(item: MenuItem, event: CustomEvent<MenuItem>): void;
  escape(event: KeyboardEvent): boolean;
  openChange(open: boolean): void;
  items(): readonly MenuEntry[];
};
export type HeaderMenuContentProps = {
  menuProps: HeaderMenuProps;
  host: SolidBridgeElement<HeaderMenuProps, HeaderMenuMethods>;
  controls: MenuControls;
  presented: boolean;
  compactView: CompactMenuView;
  onCompactViewChange: (view: CompactMenuView) => void;
  readMenu: () => MenuHandle | undefined;
  onReady: (handlers: HeaderMenuHandlers | undefined) => void;
  renderItems: (items: () => readonly MenuEntry[]) => JSX.Element;
};
const menus = new WeakMap<HTMLElement, () => MenuHandle | undefined>();
let nextMenuId = 0;

function ChatHeaderSessionMenuShell(
  liveProps: HeaderMenuProps,
  host: SolidBridgeElement<HeaderMenuProps, HeaderMenuMethods>,
) {
  const menuId = `chat-header-session-${++nextMenuId}`;
  const [compactView, setCompactView] = createSignal<CompactMenuView>("root");
  const [open, setOpen] = createSignal(false);
  const presented = () => open() || (liveProps.mobilePageOpen ?? false);
  const presentation = createParkedProjection(() => ({ ...liveProps }), presented);
  const props = createProjection(presentation, null, { key: "id" });
  const controls = createMenuControls();
  let menu: MenuHandle | undefined;
  let handlers: HeaderMenuHandlers | undefined;
  let openingFocus: Element | null | undefined;
  let focusLast = false;
  const mobile = () => props.mobile === true && Boolean(props.mobileHost) && !props.boardWidgetMenu;
  const focusReady = () => {
    const active = host.ownerDocument.activeElement;
    // Reopening can remove the focused parked row while the trigger stays connected.
    if (
      menu?.overlay.open &&
      (active === openingFocus ||
        active === menu.overlay.surface ||
        active === host.ownerDocument.body)
    ) {
      const last = focusLast ? menu.itemElements().at(-1) : undefined;
      if (last) {
        last.focus({ preventScroll: true });
      } else {
        menu.focusFirst();
      }
    }
  };
  const ready = (next: HeaderMenuHandlers | undefined) => {
    handlers = next;
    if (next && menu?.overlay.open) {
      next.openChange(true);
      focusReady();
    }
  };
  onSettled(() => {
    menus.set(host, () => menu);
    const stopKeyboard = listen(
      host,
      "keydown",
      (event) => {
        if (event.target === menu?.overlay.trigger && !menu.overlay.open) {
          focusLast = event.key === "ArrowUp";
        }
      },
      true,
    );
    return () => {
      menus.delete(host);
      stopKeyboard();
    };
  });
  const items: MenuEntry[] = [
    {
      kind: "group",
      id: "header-session-content",
      get items() {
        return handlers?.items() ?? [];
      },
      render: (renderItems) => (
        <Errored
          fallback={(error, reset) => {
            onSettled(focusReady);
            return (
              <LazyViewError
                error={error()}
                onRetry={() => {
                  openingFocus = host.ownerDocument.activeElement;
                  focusLast = false;
                  reset();
                }}
                retryRef={controls.ref()}
                inline
              />
            );
          }}
        >
          <Loading
            fallback={renderItems(() => [
              {
                id: "header-session-loading",
                label: t("common.loading"),
                disabled: true,
              },
            ])}
          >
            <Content
              menuProps={props}
              host={host}
              controls={controls}
              presented={presented()}
              compactView={compactView()}
              onCompactViewChange={setCompactView}
              readMenu={() => menu}
              onReady={ready}
              renderItems={renderItems}
            />
          </Loading>
        </Errored>
      ),
    },
  ];
  const label = () =>
    t("chat.sidebar.sessionMenu", { session: liveProps.paneTitle ?? liveProps.session.label });
  return (
    <Menu
      controls={controls}
      id={menuId}
      lazy
      class={[
        "session-menu chat-header-session-menu",
        {
          "session-menu--compact chat-header-session-menu--compact": props.compact || mobile(),
          "chat-header-session-menu--mobile": mobile(),
          "chat-header-session-menu--compact-sharing": props.compact && compactView() === "sharing",
        },
      ]}
      panelClass="chat-header-session-menu__panel"
      placement="bottom-end"
      label={label()}
      triggerClass="btn btn--ghost btn--icon chat-icon-btn chat-header-session-menu__trigger"
      trigger={<Icon name="moreHorizontal" />}
      items={items}
      onSelect={(item, event) => handlers?.select(item, event)}
      ref={(handle) => {
        menu = handle;
      }}
      onEscape={(event) => handlers?.escape(event) ?? false}
      onBeforeShow={() => {
        openingFocus = host.ownerDocument.activeElement;
        setOpen(true);
        // Refresh parked entries before completing the opening focus handoff.
        onSettled(focusReady);
      }}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        handlers?.openChange(isOpen);
        if (isOpen) {
          props.onOpen();
        } else {
          openingFocus = undefined;
          focusLast = false;
          setCompactView("root");
        }
      }}
    />
  );
}

export const ChatHeaderSessionMenu = defineSolidBridge<HeaderMenuProps, HeaderMenuMethods>(
  "openclaw-chat-header-session-menu",
  ChatHeaderSessionMenuShell,
  {
    methods: {
      openMenu: (host) => menus.get(host)?.()?.open() ?? false,
      readTrigger: (host) => menus.get(host)?.()?.overlay.trigger ?? undefined,
    },
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
