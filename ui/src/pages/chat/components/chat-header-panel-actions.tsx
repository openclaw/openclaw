import {
  createMemo,
  createUniqueId,
  Errored,
  lazy,
  Loading,
  onSettled,
  Show,
  type Element,
} from "solid-js";
import type { BoardWidgetPageMenu } from "../../../components/board/board-widget-cell-options.ts";
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
import type { KeyboardShortcutCombo } from "../../../lib/keyboard-shortcut-contract.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { ClearCompanion, ExternalPanelLink } from "../chat-panel-header-actions.tsx";
import type { ChatPageHost } from "../chat-state-host.ts";
import {
  ensureSidebarConversation,
  promoteSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  sidebarActivePanel,
  sidebarDock,
  sidebarMainPanel,
  toggleSidebarPanelExpanded,
  type SidebarLayout,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import type { HeaderMenuQuickAction } from "./chat-header-session-menu.ts";
import type { ChatQuickAction } from "./chat-quick-action.tsx";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";

registerEnglishCatalog(registerChatSessionEnglish);

const DashboardContent = lazy(() => import("./chat-header-panel-menu-content.tsx"), {
  export: "ChatDashboardMenuContent",
});
const LayoutContent = lazy(() => import("./chat-header-panel-menu-content.tsx"), {
  export: "ChatPaneLayoutMenuContent",
});

export type HeaderPanelAction = HeaderMenuQuickAction & { shortcut?: KeyboardShortcutCombo };

export type ChatPaneLayoutMenuProps = {
  paneId: string;
  narrow: boolean;
  mobile?: boolean;
  actionsDisabled?: boolean;
  panelMenuActions?: HeaderPanelAction[];
  layoutMenuActions?: HeaderMenuQuickAction[];
  sidebarLayout?: SidebarLayout;
  panelDefinitions?: SidebarPanelDefinition[];
  onLayoutChange?: ChatPageHost["updateSidebarLayout"];
  onToggleSidePanel?: () => void;
  onCloseSidePanel?: (slot: SidebarSlotId) => void;
  onOpenSplitView?: () => void;
  onSplitDown?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
};

export function chatPaneLayoutModel(props: ChatPaneLayoutMenuProps) {
  const layout = props.sidebarLayout;
  const definitions = props.panelDefinitions ?? [];
  const side = layout ? sidebarActivePanel(layout) : undefined;
  const mainSlot = layout ? (sidebarMainPanel(layout)?.slot ?? "conversation") : "conversation";
  const mainDefinition = definitions.find((definition) => definition.slot === mainSlot);
  const sideDefinition = definitions.find((definition) => definition.slot === side?.slot);
  const split = layout?.open === true && !layout.expanded;
  const actions: ChatQuickAction[] = [];
  if (layout && props.onLayoutChange && (split || layout.expanded)) {
    actions.push({
      id: "focus",
      className: "chat-panel-focus",
      label: t(layout.expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expand"),
      icon: layout.expanded ? "minimize" : "maximize",
      active: layout.expanded === true,
      onActivate: () =>
        props.onLayoutChange?.(
          setSidebarExpanded(ensureSidebarConversation(layout), layout.expanded !== true),
          { dashboardPresentation: "personal" },
        ),
    });
  }
  if (layout && props.onLayoutChange && split && side && mainDefinition && sideDefinition) {
    actions.push({
      id: "swap",
      className: "chat-panel-swap",
      label: t("chat.sidePanel.swap", { main: mainDefinition.label, side: sideDefinition.label }),
      icon: "arrowLeftRight",
      onActivate: () => props.onLayoutChange?.(promoteSidebarPanel(layout, side.id)),
    });
  }
  if (
    layout &&
    side &&
    sideDefinition &&
    !layout.expanded &&
    !props.narrow &&
    props.onLayoutChange
  ) {
    actions.push({
      id: "expand-side-panel",
      className: "side-panel__expand",
      label: t("chat.sidePanel.expandPanel", { panel: sideDefinition.label }),
      icon: "maximize",
      onActivate: () =>
        props.onLayoutChange?.(toggleSidebarPanelExpanded(layout, side.id), {
          dashboardPresentation: "personal",
        }),
    });
  }
  if (side && sideDefinition && props.onCloseSidePanel) {
    actions.push({
      id: "close-side-panel",
      label: t("chat.sidebarColumns.close", { panel: sideDefinition.label }),
      icon: "x",
      onActivate: async () => {
        if (props.mobile === false && side.slot === "companion") {
          const paneId = props.paneId;
          const clear = sideDefinition.view?.onClearCompanion;
          if (
            !clear ||
            !(await clear()) ||
            props.paneId !== paneId ||
            !props.sidebarLayout ||
            sidebarActivePanel(props.sidebarLayout)?.id !== side.id
          ) {
            return;
          }
        }
        props.onCloseSidePanel?.(side.slot);
      },
    });
  }
  if (props.onToggleSidePanel) {
    actions.push({
      id: "side-panel",
      className: "chat-side-panel-toggle",
      label: t(split ? "chat.sidePanel.minimize" : "chat.sidePanel.label"),
      icon: split ? "panelRightClose" : "panelRightOpen",
      active: split,
      onActivate: props.onToggleSidePanel,
    });
  }
  actions.push(...(props.layoutMenuActions ?? []));
  for (const [id, label, icon, callback] of [
    ["open-split-view", "chat.splitView.open", "columns2", props.onOpenSplitView],
    ["split-down", "chat.splitView.splitDown", "panelBottomOpen", props.onSplitDown],
    ["split-right", "chat.splitView.splitRight", "panelRightOpen", props.onSplitRight],
    ["close-pane", "chat.splitView.closePane", "x", props.onClosePane],
  ] as const) {
    if (callback && (!props.narrow || (id !== "split-down" && id !== "split-right"))) {
      actions.push({
        id,
        label: t(label),
        className: id === "open-split-view" ? "chat-open-split-view" : `chat-pane__${id}`,
        icon,
        disabled: props.actionsDisabled,
        onActivate: () =>
          id === "open-split-view" ? props.onOpenSplitView?.() : callback(props.paneId),
      });
    }
  }
  if (layout && props.onLayoutChange && !props.narrow && split) {
    for (const [dock, label, icon] of [
      ["left", "dockLeft", "panelLeftOpen"],
      ["right", "dockRight", "panelRightOpen"],
      ["bottom", "dockBottom", "panelBottomOpen"],
    ] as const) {
      actions.push({
        id: `dock-${dock}`,
        label: t(`chat.sidePanel.${label}`),
        icon,
        active: sidebarDock(layout) === dock,
        onActivate: () =>
          props.onLayoutChange?.(setSidebarDock(layout, dock), { geometryOnly: true }),
      });
    }
  }
  const panelActions: ChatQuickAction[] = props.panelMenuActions ?? [];
  const allActions = [...actions, ...panelActions];
  return {
    actions,
    panelActions,
    allActions,
    mainHeaderActionView: mainDefinition?.headerActionView,
    sideHeaderActionView: sideDefinition?.headerActionView,
    mainHeaderLink: mainDefinition?.headerLink,
    sideHeaderLink: sideDefinition?.headerLink,
  };
}
/** Renders definition-owned controls without mounting the panel's content/view. */
export function ChatPanelHeaderActions(
  props: Pick<SidebarPanelDefinition, "headerActionView" | "headerLink"> & {
    controls?: MenuControls;
  },
) {
  return (
    <>
      <Show when={props.headerActionView}>
        {(view) => <ClearCompanion {...view()} actionRef={props.controls?.ref()} />}
      </Show>
      <Show when={props.headerLink}>
        {(link) => <ExternalPanelLink {...link()} actionRef={props.controls?.ref()} />}
      </Show>
    </>
  );
}

type ChatPanelMenuHandlers = {
  items: () => readonly MenuEntry[];
  select: (item: MenuItem, event: CustomEvent<MenuItem>) => void;
};
export type ChatPanelMenuContentProps = {
  menuProps: ChatPaneLayoutMenuProps & { widgetMenu?: BoardWidgetPageMenu };
  controls: MenuControls;
  readMenu: () => MenuHandle | undefined;
  onReady: (handlers: ChatPanelMenuHandlers | undefined) => void;
  renderItems: (items: () => readonly MenuEntry[]) => Element;
};

/** Hand off initial keyboard focus only while the opening gesture still owns it. */
function createPanelMenuFocusHandoff() {
  let menu: MenuHandle | undefined;
  let openingFocus: globalThis.Element | null | undefined;
  let focusLast = false;
  let stopKeyboard: (() => void) | undefined;
  onSettled(() => () => stopKeyboard?.());
  return {
    read: () => menu,
    bind(this: void, handle: MenuHandle) {
      menu = handle;
      stopKeyboard?.();
      const trigger = handle.overlay.trigger;
      stopKeyboard = trigger
        ? listen(
            trigger,
            "keydown",
            (event) => {
              if (!handle.overlay.open) {
                focusLast = event.key === "ArrowUp";
              }
            },
            true,
          )
        : undefined;
    },
    beforeShow(this: void) {
      openingFocus = menu?.overlay.surface.ownerDocument.activeElement;
    },
    openChange(this: void, open: boolean) {
      if (!open) {
        openingFocus = undefined;
        focusLast = false;
      }
    },
    focusReady(this: void) {
      if (!menu?.overlay.open) {
        return;
      }
      const active = menu.overlay.surface.ownerDocument.activeElement;
      if (
        active !== openingFocus &&
        active !== menu.overlay.surface &&
        active !== menu.overlay.surface.ownerDocument.body
      ) {
        return;
      }
      const last = focusLast ? menu.itemElements().at(-1) : undefined;
      if (last) {
        last.focus({ preventScroll: true });
      } else {
        menu.focusFirst();
      }
    },
  };
}

function ChatPanelMenuBoundary(props: {
  controls: MenuControls;
  focusReady: () => void;
  fallback: Element;
  children: Element;
}) {
  return (
    <Errored
      fallback={(error, reset) => {
        onSettled(props.focusReady);
        return (
          <LazyViewError error={error()} onRetry={reset} retryRef={props.controls.ref()} inline />
        );
      }}
    >
      <Loading fallback={props.fallback}>{props.children}</Loading>
    </Errored>
  );
}

/** External Dashboard controls reuse the layout and page-widget owners. */
export function ChatDashboardMenu(
  props: ChatPaneLayoutMenuProps & {
    widgetMenu?: BoardWidgetPageMenu;
  },
) {
  const id = createUniqueId();
  const controls = createMenuControls();
  const focus = createPanelMenuFocusHandoff();
  let handlers: ChatPanelMenuHandlers | undefined;
  return (
    <Menu
      controls={controls}
      lazy="while-open"
      id={`chat-dashboard-${id}`}
      label={t("chat.sidePanel.dashboardOptions")}
      class="chat-dashboard-menu"
      panelClass="chat-dashboard-menu__panel"
      placement="bottom-end"
      triggerClass="chat-dashboard-menu__trigger"
      triggerAttributes={{ title: t("chat.sidePanel.dashboardOptions") }}
      trigger={
        <>
          <Icon name="layoutDashboard" />
          <Icon name="chevronDown" class="chat-dashboard-menu__chevron" />
        </>
      }
      items={[
        {
          kind: "group",
          id: "dashboard-content",
          get items() {
            return handlers?.items() ?? [];
          },
          render: (renderItems) => (
            <ChatPanelMenuBoundary
              controls={controls}
              focusReady={focus.focusReady}
              fallback={renderItems(() => [
                { id: "loading", label: t("common.loading"), disabled: true },
              ])}
            >
              <DashboardContent
                menuProps={props}
                controls={controls}
                readMenu={focus.read}
                onReady={(next) => {
                  handlers = next;
                  if (next) {
                    onSettled(focus.focusReady);
                  }
                }}
                renderItems={renderItems}
              />
            </ChatPanelMenuBoundary>
          ),
        },
      ]}
      ref={focus.bind}
      onBeforeShow={focus.beforeShow}
      onOpenChange={focus.openChange}
      onSelect={(item, event) => handlers?.select(item, event)}
    />
  );
}

export function ChatPaneLayoutHeaderActions(props: {
  model: ReturnType<typeof chatPaneLayoutModel>;
  controls?: MenuControls;
  /** Set only when the corresponding visible panel header supplies these controls. */
  omitMain?: boolean;
  omitSide?: boolean;
}) {
  return (
    <>
      <Show when={!props.omitMain}>
        <ChatPanelHeaderActions
          controls={props.controls}
          headerActionView={props.model.mainHeaderActionView}
          headerLink={props.model.mainHeaderLink}
        />
      </Show>
      <Show when={!props.omitSide}>
        <ChatPanelHeaderActions
          controls={props.controls}
          headerActionView={props.model.sideHeaderActionView}
          headerLink={props.model.sideHeaderLink}
        />
      </Show>
    </>
  );
}

let nextLayoutId = 0;

export function ChatPaneLayoutMenu(props: ChatPaneLayoutMenuProps) {
  const id = `chat-pane-layout-${++nextLayoutId}`;
  const controls = createMenuControls();
  const focus = createPanelMenuFocusHandoff();
  const model = createMemo(() => chatPaneLayoutModel(props));
  let handlers: ChatPanelMenuHandlers | undefined;

  return (
    <Show
      when={model().allActions.length > 0 || model().mainHeaderActionView || model().mainHeaderLink}
    >
      <Menu
        controls={controls}
        lazy
        id={id}
        class={[
          "chat-pane__layout-menu chat-panel-layout-menu",
          { "chat-panel-layout-menu--mobile": props.mobile },
        ]}
        placement="bottom-end"
        label={t(props.mobile ? "chat.sessionHeader.panels" : "chat.sessionHeader.layout")}
        triggerClass="btn btn--ghost chat-pane__layout-trigger"
        trigger={
          <>
            <span aria-hidden="true">
              <Icon name={props.mobile ? "panelRightOpen" : "columns2"} />
            </span>
            <Show when={!props.mobile}>{t("chat.sessionHeader.layout")}</Show>
          </>
        }
        items={[
          {
            kind: "group",
            id: "layout-content",
            get items() {
              return handlers?.items() ?? [];
            },
            render: (renderItems) => (
              <ChatPanelMenuBoundary
                controls={controls}
                focusReady={focus.focusReady}
                fallback={renderItems(() => [
                  { id: "loading", label: t("common.loading"), disabled: true },
                ])}
              >
                <LayoutContent
                  menuProps={props}
                  controls={controls}
                  readMenu={focus.read}
                  onReady={(next) => {
                    handlers = next;
                    if (next) {
                      onSettled(focus.focusReady);
                    }
                  }}
                  renderItems={renderItems}
                />
              </ChatPanelMenuBoundary>
            ),
          },
        ]}
        ref={focus.bind}
        onBeforeShow={focus.beforeShow}
        onOpenChange={focus.openChange}
        onSelect={(item, event) => handlers?.select(item, event)}
      />
    </Show>
  );
}
