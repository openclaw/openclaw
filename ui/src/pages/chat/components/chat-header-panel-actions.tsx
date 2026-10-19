import { createMemo, createUniqueId, Show } from "solid-js";
import { BoardGrantedCapabilities } from "../../../components/board/board-widget-capabilities.solid.tsx";
import {
  BOARD_SIZE_PRESETS,
  type BoardWidgetPageMenu,
} from "../../../components/board/board-widget-cell-options.ts";
import { boardWidgetMenuEntries } from "../../../components/board/board-widget-menu.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  createMenuControls,
  Menu,
  type MenuControls,
  type MenuEntry,
  type MenuHandle,
} from "../../../components/solid/menu.tsx";
import type { KeyboardShortcutCombo } from "../../../lib/keyboard-shortcut-contract.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ClearCompanion, ExternalPanelLink } from "../chat-pane-embedded-view.tsx";
import type { ChatPageHost } from "../chat-state-host.ts";
import {
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
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
import { useChatQuickActionEntries, type ChatQuickAction } from "./chat-quick-action.tsx";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";

export type HeaderPanelAction = HeaderMenuQuickAction & { shortcut?: KeyboardShortcutCombo };

export type ChatPaneLayoutMenuProps = {
  paneId: string;
  narrow: boolean;
  mobile?: boolean;
  actionsDisabled?: boolean;
  panelMenuActions?: HeaderPanelAction[];
  layoutMenuActions?: HeaderMenuQuickAction[];
  sidebarLayout?: SidebarLayout;
  sidePanelOpen?: boolean;
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
  const sidePanelOpen = props.sidePanelOpen ?? split;
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
      label: t(sidePanelOpen ? "chat.sidePanel.minimize" : "chat.sidePanel.label"),
      icon: sidePanelOpen ? "panelRightClose" : "panelRightOpen",
      active: sidePanelOpen,
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
  const createClaw =
    layout && isSidebarSlotVisible(layout, "companion")
      ? definitions.find((definition) => definition.slot === "companion")?.view?.onCreateClaw
      : undefined;
  if (createClaw) {
    actions.push({
      id: "create-claw",
      label: t("clawsDraft.title"),
      description: t("clawsDraft.railHint"),
      icon: "box",
      onActivate: createClaw,
    });
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

/** External Dashboard controls reuse the layout and page-widget owners. */
export function ChatDashboardMenu(
  props: ChatPaneLayoutMenuProps & {
    widgetMenu?: BoardWidgetPageMenu;
  },
) {
  const id = createUniqueId();
  let menu: MenuHandle | undefined;
  const actions = createMemo((): ChatQuickAction[] => {
    const layout = props.sidebarLayout;
    const result: ChatQuickAction[] = [];
    // The shared mobile host owns expansion without changing the retained desktop layout.
    if (!props.mobile && layout && props.onLayoutChange) {
      const main = sidebarMainPanel(layout);
      const dashboard = layout.columns
        .flatMap((column) => column.panels)
        .find((panel) => panel.slot === "dashboard");
      if (dashboard && layout.open && !layout.expanded) {
        result.push({
          id: "dashboard-swap",
          label: t("chat.sidePanel.swap", {
            main: t("chat.sidePanel.conversation"),
            side: t("chat.sidePanel.dashboard"),
          }),
          icon: "arrowLeftRight",
          onActivate: () => {
            const next = ensureSidebarConversation(layout);
            const target =
              main?.slot === "dashboard"
                ? next.columns
                    .flatMap((column) => column.panels)
                    .find((panel) => panel.slot === "conversation")
                : dashboard;
            if (target) {
              props.onLayoutChange?.(
                openSlot(
                  promoteSidebarPanel(next, target.id),
                  main?.slot === "dashboard" ? "dashboard" : "conversation",
                ),
                { dashboardPresentation: "personal" },
              );
            }
          },
        });
      }
      if (dashboard) {
        result.push({
          id: "dashboard-expand",
          label: t(layout.expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expandPanel", {
            panel: t("chat.sidePanel.dashboard"),
          }),
          icon: layout.expanded ? "minimize" : "maximize",
          onActivate: () =>
            props.onLayoutChange?.(
              main?.slot === "dashboard" || layout.expanded
                ? setSidebarExpanded(layout, !layout.expanded)
                : toggleSidebarPanelExpanded(layout, dashboard.id),
              { dashboardPresentation: "personal" },
            ),
        });
      }
      if (!isSidebarSlotVisible(layout, "conversation")) {
        result.push({
          id: "dashboard-show-chat",
          label: t("chat.sidePanel.showChat"),
          icon: "messageSquare",
          onActivate: () =>
            props.onLayoutChange?.(openSlot(ensureSidebarConversation(layout), "conversation"), {
              dashboardPresentation: "personal",
            }),
        });
      }
    }
    for (const action of props.layoutMenuActions ?? []) {
      if (action.id === "dashboard-default") {
        result.push({ ...action, icon: "bookmark" });
      }
    }
    return result;
  });
  const actionItems = useChatQuickActionEntries(actions);
  const groupedActionItems = createMemo((): MenuEntry[] =>
    actionItems().flatMap((entry): MenuEntry[] =>
      entry.id !== "dashboard-default"
        ? [entry]
        : [
            {
              kind: "content",
              id: "default-separator",
              content: <div class="board-widget__menu-separator" role="separator" />,
            },
            entry.kind === "content"
              ? {
                  id: `${entry.id}-status`,
                  label: actions().find((action) => action.id === entry.id)!.label,
                  disabled: true,
                  render: (attributes) => (
                    <div {...attributes} class="chat-dashboard-menu__default-status">
                      {entry.content}
                      <Icon name="check" />
                    </div>
                  ),
                }
              : entry,
          ],
    ),
  );
  const widgetItems = createMemo((): MenuEntry[] => {
    const page = props.widgetMenu;
    if (!page?.canMutate) {
      return [];
    }
    const entries = boardWidgetMenuEntries({ ...page, disabled: false });
    const destinations = entries.filter((entry) => entry.id.startsWith("move:"));
    const currentSize = Object.entries(BOARD_SIZE_PRESETS).find(
      ([, size]) => size.w === page.widget.sizeW && size.h === page.widget.sizeH,
    )?.[0];
    // These are fresh menu projections; widget state and action IDs stay native.
    for (const entry of entries) {
      if (entry.kind === "content" || entry.kind === "group") {
        continue;
      }
      if (entry.id.startsWith("resize:")) {
        entry.class = [
          "board-widget__preset",
          { "is-current": entry.id === `resize:${currentSize}` },
        ];
      } else if (entry.id === "height:auto") {
        entry.icon = <Icon name="arrowUpDown" />;
      }
    }
    return [
      {
        kind: "content",
        id: "page-separator",
        content: <div class="board-widget__menu-separator" role="separator" />,
      },
      {
        kind: "content",
        id: "resize-heading",
        content: <div class="board-widget__menu-heading">{t("chat.sidePanel.dashboardSize")}</div>,
      },
      {
        kind: "group",
        id: "page-sizes",
        class: "chat-dashboard-menu__sizes",
        items: entries.filter((entry) => entry.id.startsWith("resize:")),
      },
      ...entries.filter((entry) => entry.id === "height:auto"),
      ...(destinations.length
        ? [
            {
              id: "page-move",
              label: t("board.widget.moveToTab"),
              icon: <Icon name="panelsTopLeft" />,
              children: destinations,
            },
          ]
        : []),
      ...entries.filter((entry) => entry.id === "separator" || entry.id === "remove"),
    ];
  });
  return (
    <Menu
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
        ...groupedActionItems(),
        ...widgetItems(),
        {
          kind: "content",
          id: "page-granted-capabilities",
          content: (
            <Show when={props.widgetMenu}>
              {(page) => <BoardGrantedCapabilities widget={page().widget} presentation="details" />}
            </Show>
          ),
        },
      ]}
      ref={(handle) => {
        menu = handle;
      }}
      onSelect={(item, event) => {
        event.preventDefault();
        menu?.close();
        const action = actions().find((candidate) => candidate.id === item.id);
        if (action) {
          if (action.kind !== "status" && !action.disabled) {
            void action.onActivate();
          }
        } else {
          props.widgetMenu?.onSelect(item.id);
        }
      }}
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
  let menu: MenuHandle | undefined;
  const model = createMemo(() => chatPaneLayoutModel(props));
  const headerActions = createMemo(
    () => <ChatPaneLayoutHeaderActions model={model()} controls={controls} />,
    { lazy: true },
  );
  const primary = useChatQuickActionEntries(
    () => (props.mobile ? model().panelActions : model().actions),
    true,
  );
  const secondary = useChatQuickActionEntries(
    () => (props.mobile ? model().actions : model().panelActions),
    true,
  );
  const items = createMemo(
    (): MenuEntry[] => {
      return [
        ...primary(),
        ...(primary().length && secondary().length
          ? [
              {
                kind: "content" as const,
                id: "panel-actions",
                content: <div class="session-menu__separator" role="separator" />,
              },
            ]
          : []),
        ...secondary(),
        {
          kind: "content",
          id: "header-actions",
          content: headerActions(),
        },
      ];
    },
    { lazy: true },
  );
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
        items={items()}
        ref={(handle) => {
          menu = handle;
        }}
        onSelect={(item, event) => {
          const action = model().allActions.find((candidate) => candidate.id === item.id);
          if (action && action.kind !== "status" && !action.disabled) {
            event.preventDefault();
            menu?.close();
            void action.onActivate();
          }
        }}
      />
    </Show>
  );
}
