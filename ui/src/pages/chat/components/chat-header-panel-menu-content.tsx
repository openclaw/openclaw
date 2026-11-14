import { createMemo, merge, onSettled, Show } from "solid-js";
import { BoardGrantedCapabilities } from "../../../components/board/board-widget-capabilities.solid.tsx";
import { BOARD_SIZE_PRESETS } from "../../../components/board/board-widget-cell-options.ts";
import { boardWidgetMenuEntries } from "../../../components/board/board-widget-menu.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuEntry } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
  setSidebarExpanded,
  sidebarMainPanel,
  toggleSidebarPanelExpanded,
} from "../sidebar-layout.ts";
import {
  chatPaneLayoutModel,
  ChatPaneLayoutHeaderActions,
  type ChatPanelMenuContentProps,
} from "./chat-header-panel-actions.tsx";
import { useChatQuickActionEntries, type ChatQuickAction } from "./chat-quick-action.tsx";

export function ChatDashboardMenuContent(inputs: ChatPanelMenuContentProps) {
  const props = merge(() => inputs.menuProps);
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
  const items = createMemo((): MenuEntry[] => [
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
  ]);
  onSettled(() => {
    inputs.onReady({
      items,
      select: (item, event) => {
        event.preventDefault();
        inputs.readMenu()?.close();
        const action = actions().find((candidate) => candidate.id === item.id);
        if (action) {
          if (action.kind !== "status" && !action.disabled) {
            void action.onActivate();
          }
        } else {
          props.widgetMenu?.onSelect(item.id);
        }
      },
    });
    return () => inputs.onReady(undefined);
  });
  return inputs.renderItems(items);
}

export function ChatPaneLayoutMenuContent(inputs: ChatPanelMenuContentProps) {
  const props = merge(() => inputs.menuProps);
  const controls = inputs.controls;
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
  onSettled(() => {
    inputs.onReady({
      items,
      select: (item, event) => {
        const action = model().allActions.find((candidate) => candidate.id === item.id);
        if (action && action.kind !== "status" && !action.disabled) {
          event.preventDefault();
          inputs.readMenu()?.close();
          void action.onActivate();
        }
      },
    });
    return () => inputs.onReady(undefined);
  });
  return inputs.renderItems(items);
}
