import { createMemo, createUniqueId } from "solid-js";
import type { BoardTab, BoardWidget } from "../../lib/board/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "../solid/icon.tsx";
import { Menu, type MenuEntry, type MenuHandle } from "../solid/menu.tsx";
import { BOARD_SIZE_PRESETS } from "./board-widget-cell-options.ts";

export function BoardWidgetMenu(props: {
  widget: BoardWidget;
  tabs: readonly BoardTab[];
  disabled: boolean;
  onSelect: (value: string) => void;
  ref: (handle: MenuHandle) => void;
}) {
  const id = createUniqueId();
  const items = createMemo((): MenuEntry[] => {
    const tabs = props.tabs.filter((tab) => tab.tabId !== props.widget.tabId);
    return [
      {
        kind: "content",
        id: "move-heading",
        content: <div class="board-widget__menu-heading">{t("board.widget.moveToTab")}</div>,
      },
      ...tabs.map((tab) => ({
        id: `move:${tab.tabId}`,
        label: tab.title,
        disabled: props.disabled,
      })),
      ...(tabs.length
        ? []
        : [
            {
              kind: "content" as const,
              id: "no-tabs",
              content: (
                <span class="board-widget__menu-empty">{t("board.widget.noOtherTabs")}</span>
              ),
            },
          ]),
      {
        kind: "content",
        id: "resize-heading",
        content: <div class="board-widget__menu-heading">{t("board.widget.resize")}</div>,
      },
      ...Object.entries(BOARD_SIZE_PRESETS).map(([label, size]) => ({
        id: `resize:${label}`,
        label: label.toUpperCase(),
        class: "board-widget__preset",
        disabled: props.disabled,
        details: (
          <span>
            {size.w}×{size.h}
          </span>
        ),
      })),
      ...(props.widget.contentKind === "html"
        ? [
            {
              id: "height:auto",
              label: t("board.widget.autoHeight"),
              class: "board-widget__preset",
              type: "checkbox" as const,
              checked: props.widget.heightMode !== "fixed",
              disabled: props.disabled,
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
        disabled: props.disabled,
        icon: (
          <span class="board-widget__menu-icon" aria-hidden="true">
            <Icon name="trash" />
          </span>
        ),
      },
    ];
  });
  return (
    <Menu
      id={id}
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
