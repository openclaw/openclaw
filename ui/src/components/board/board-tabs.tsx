import { createEffect, createMemo, createUniqueId, Show } from "solid-js";
import type { BoardTab } from "../../lib/board/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { Menu } from "../solid/menu.tsx";
import { Tabs } from "../solid/tabs.tsx";

export function orderedBoardTabs(tabs: readonly BoardTab[]): BoardTab[] {
  return tabs.toSorted(
    (left, right) => left.position - right.position || left.tabId.localeCompare(right.tabId),
  );
}

export function BoardTabs(props: {
  tabs: readonly BoardTab[];
  activeTabId: string;
  hoverTabId: string;
  onSelect: (tabId: string) => void;
}) {
  const overflowId = createUniqueId();
  const visible = createMemo(() => {
    const tabs = props.tabs.slice(0, 6);
    const active = props.tabs.find((tab) => tab.tabId === props.activeTabId);
    if (active && !tabs.some((tab) => tab.tabId === active.tabId)) {
      tabs[tabs.length - 1] = active;
    }
    return tabs;
  });
  const overflow = createMemo(() => {
    const visibleIds = new Set(visible().map((tab) => tab.tabId));
    return props.tabs.filter((tab) => !visibleIds.has(tab.tabId));
  });
  let track: HTMLDivElement | undefined;
  const layoutKey = createMemo(() =>
    JSON.stringify([props.activeTabId, visible().map((tab) => tab.tabId)]),
  );
  createEffect(layoutKey, () => {
    // Read selection after the keyed tab items have committed.
    queueMicrotask(() => {
      const scroller = track;
      const selected = scroller?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!scroller || !selected) {
        return;
      }
      const viewport = scroller.getBoundingClientRect();
      const tab = selected.getBoundingClientRect();
      if (tab.left < viewport.left) {
        scroller.scrollLeft += tab.left - viewport.left;
      } else if (tab.right > viewport.right) {
        scroller.scrollLeft += tab.right - viewport.right;
      }
    });
  });
  return (
    <Show when={props.tabs.length > 1}>
      <nav class="board-tabs" aria-label={t("board.tabsLabel")}>
        <Tabs
          ref={(element) => {
            track = element;
          }}
          class="board-tabs__track"
          active={props.activeTabId}
          activation="manual"
          ariaLabel={t("board.tabsLabel")}
          items={visible().map((tab) => ({
            value: tab.tabId,
            label: tab.title,
            className: {
              "board-tabs__tab": true,
              "board-tabs__tab--active": tab.tabId === props.activeTabId,
              "board-tabs__tab--drop": tab.tabId === props.hoverTabId,
            },
            attributes: { "data-board-tab-id": tab.tabId },
          }))}
          onSelect={(tabId) => props.onSelect(tabId)}
        />
        <Show when={overflow().length > 0}>
          <Menu
            id={overflowId}
            class="board-tabs__overflow"
            panelClass="board-tabs__overflow-panel"
            triggerClass="board-tabs__overflow-trigger"
            label={t("board.moreTabs")}
            trigger="•••"
            triggerAttributes={{ title: t("board.moreTabs") }}
            placement="bottom-end"
            items={overflow().map((tab) => ({
              id: tab.tabId,
              label: tab.title,
              class: "board-tabs__overflow-item",
              attributes: { "data-board-tab-id": tab.tabId },
            }))}
            onSelect={(item) => props.onSelect(item.id)}
          />
        </Show>
      </nav>
    </Show>
  );
}
