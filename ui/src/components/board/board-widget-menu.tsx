import { createMemo, createUniqueId } from "solid-js";
import type { BoardTab, BoardWidget } from "../../lib/board/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "../solid/icon.tsx";
import { MenuHeading } from "../solid/menu-heading.tsx";
import { Menu, type MenuEntry, type MenuHandle } from "../solid/menu.tsx";
import type { BoardWidgetCellProps } from "./board-widget-cell-options.ts";
import { BOARD_SIZE_PRESETS } from "./board-widget-cell-options.ts";

export function boardWidgetMenuEntries(params: {
  widget: BoardWidget;
  tabs: readonly BoardTab[];
  disabled: boolean;
}): MenuEntry[] {
  const tabs = params.tabs.filter((tab) => tab.tabId !== params.widget.tabId);
  return [
    {
      kind: "content",
      id: "move-heading",
      content: <MenuHeading label={t("board.widget.moveToTab")} />,
    },
    ...tabs.map((tab) => ({
      id: `move:${tab.tabId}`,
      label: tab.title,
      disabled: params.disabled,
    })),
    ...(tabs.length
      ? []
      : [
          {
            kind: "content" as const,
            id: "no-tabs",
            content: <span class="board-widget__menu-empty">{t("board.widget.noOtherTabs")}</span>,
          },
        ]),
    {
      kind: "content",
      id: "resize-heading",
      content: <MenuHeading label={t("board.widget.resize")} />,
    },
    ...Object.entries(BOARD_SIZE_PRESETS).map(([label, size]) => ({
      id: `resize:${label}`,
      label: label.toUpperCase(),
      class: "board-widget__preset",
      disabled: params.disabled,
      details: (
        <span>
          {size.w}×{size.h}
        </span>
      ),
    })),
    ...(params.widget.contentKind === "html"
      ? [
          {
            id: "height:auto",
            label: t("board.widget.autoHeight"),
            class: "board-widget__preset",
            type: "checkbox" as const,
            checked: params.widget.heightMode !== "fixed",
            disabled: params.disabled,
          },
        ]
      : []),
    {
      kind: "content",
      id: "separator",
      content: <div class="board-widget__menu-separator" role="separator" />,
    },
    {
      id: "remove",
      label: t("board.widget.remove"),
      class: "board-widget__menu-danger",
      disabled: params.disabled,
      icon: (
        <span class="board-widget__menu-icon" aria-hidden="true">
          <Icon name="trash" />
        </span>
      ),
    },
  ];
}

export function BoardWidgetMenu(props: {
  widget: BoardWidget;
  tabs: readonly BoardTab[];
  disabled: boolean;
  onSelect: (value: string) => void;
  ref: (handle: MenuHandle) => void;
}) {
  const id = createUniqueId();
  const items = createMemo(() => boardWidgetMenuEntries(props), { lazy: true });
  return (
    <Menu
      id={id}
      lazy
      ref={props.ref}
      class="board-widget__menu"
      panelClass="board-widget__menu-panel"
      triggerClass="board-widget__menu-trigger"
      trigger="⋮"
      triggerAttributes={{ title: t("board.widget.menuLabel") }}
      label={t("board.widget.menuLabel")}
      placement="bottom-end"
      items={items()}
      onSelect={(item, event) => {
        event.preventDefault();
        props.onSelect(item.id);
      }}
    />
  );
}

export function handleBoardWidgetMenuAction(options: {
  value: string | undefined;
  props: BoardWidgetCellProps;
  run: (action: () => Promise<void>) => void;
  close: () => void;
}) {
  const { value, props, run, close } = options;
  const widget = props.widget;
  const callbacks = props.callbacks;
  if (!widget || !callbacks || props.active === false || props.canMutate === false) {
    return;
  }
  if (props.lobby) {
    close();
    return;
  }
  if (value === "remove") {
    run(() => callbacks.remove(widget));
  } else if (value?.startsWith("move:")) {
    run(() => callbacks.moveToTab(widget, value.slice(5)));
  } else if (value?.startsWith("resize:")) {
    const size = Object.entries(BOARD_SIZE_PRESETS).find(
      ([preset]) => preset === value.slice(7),
    )?.[1];
    if (size) {
      run(() => callbacks.resizeTo(widget, size.w, size.h));
    }
  } else if (value === "height:auto") {
    run(() => callbacks.setHeightMode(widget, widget.heightMode !== "fixed" ? "fixed" : "auto"));
  }
}
