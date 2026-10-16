import { createMemo, createSignal, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry, type MenuHandle } from "../../../components/solid/menu.tsx";
import type { KeyboardShortcutCombo } from "../../../lib/keyboard-shortcut-contract.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ClearCompanion, ExternalPanelLink } from "../chat-pane-embedded-view.tsx";
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
import { chatQuickActionEntry, type ChatQuickAction } from "./chat-quick-action.tsx";
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
  panelDefinitions?: SidebarPanelDefinition[];
  onLayoutChange?: ChatPageHost["updateSidebarLayout"];
  onToggleSidePanel?: () => void;
  onCloseSidePanel?: (slot: SidebarSlotId) => void;
  onOpenSplitView?: () => void;
  onSplitDown?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
};

function layoutModel(props: ChatPaneLayoutMenuProps) {
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
      onActivate: () => props.onCloseSidePanel?.(side.slot),
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
    mainHeaderAction: mainDefinition?.headerAction,
    sideHeaderAction: sideDefinition?.headerAction,
    mainHeaderActionView: mainDefinition?.headerActionView,
    sideHeaderActionView: sideDefinition?.headerActionView,
    mainHeaderLink: mainDefinition?.headerLink,
    sideHeaderLink: sideDefinition?.headerLink,
  };
}
let nextLayoutId = 0;

export function ChatPaneLayoutMenu(props: ChatPaneLayoutMenuProps) {
  const id = `chat-pane-layout-${++nextLayoutId}`;
  const [opened, setOpened] = createSignal(false);
  let menu: MenuHandle | undefined;
  const model = createMemo(() => layoutModel(props));
  const headerActions = (
    <Show when={opened() || model().allActions.length === 0}>
      {model().mainHeaderAction}
      <Show when={model().mainHeaderActionView}>{(view) => <ClearCompanion {...view()} />}</Show>
      <Show when={model().mainHeaderLink}>{(link) => <ExternalPanelLink {...link()} />}</Show>
      {model().sideHeaderAction}
      <Show when={model().sideHeaderActionView}>{(view) => <ClearCompanion {...view()} />}</Show>
      <Show when={model().sideHeaderLink}>{(link) => <ExternalPanelLink {...link()} />}</Show>
    </Show>
  );
  const items = createMemo((): MenuEntry[] => {
    const { actions, panelActions } = model();
    const primary = props.mobile ? panelActions : actions;
    const secondary = props.mobile ? actions : panelActions;
    return [
      ...primary.map((action) => chatQuickActionEntry(action, action.id, true)),
      ...(primary.length && secondary.length
        ? [
            {
              kind: "content" as const,
              id: "panel-actions",
              content: <div class="session-menu__separator" role="separator" />,
            },
          ]
        : []),
      ...secondary.map((action) => chatQuickActionEntry(action, action.id, true)),
      {
        kind: "content",
        id: "header-actions",
        content: headerActions,
      },
    ];
  });
  return (
    <Show
      when={
        model().allActions.length > 0 ||
        model().mainHeaderAction ||
        model().mainHeaderActionView ||
        model().mainHeaderLink
      }
    >
      <Menu
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
        onOpenChange={(open) => {
          if (open) {
            setOpened(true);
          }
        }}
        ref={(handle) => {
          menu = handle;
        }}
        onSelect={(item, event) => {
          const action = model().allActions.find((candidate) => candidate.id === item.id);
          if (action && action.kind !== "status" && !action.disabled) {
            event.preventDefault();
            menu?.close();
            action.onActivate();
          }
        }}
      />
    </Show>
  );
}
