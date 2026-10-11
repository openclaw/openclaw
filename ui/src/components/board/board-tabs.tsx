import { createMemo, For, Show } from "solid-js";
import type { BoardTab } from "../../lib/board/types.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function orderedBoardTabs(tabs: readonly BoardTab[]): BoardTab[] {
  return tabs.toSorted(
    (left, right) => left.position - right.position || left.tabId.localeCompare(right.tabId),
  );
}

export function BoardTabs(props: {
  tabs: readonly BoardTab[];
  activeTabId: string;
  hoverTabId: string;
  onTabShow: (event: CustomEvent<{ name: string }>) => void;
  onOverflowSelect: (event: CustomEvent<{ item: { value?: string } }>) => void;
}) {
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
  return (
    <Show when={props.tabs.length > 1}>
      <nav class="board-tabs" aria-label={t("board.tabsLabel")}>
        <wa-tab-group
          class="board-tabs__track"
          prop:active={props.activeTabId}
          prop:activation="manual"
          prop:withoutScrollControls={true}
          onWa-tab-show={(event: CustomEvent<{ name: string }>) => props.onTabShow(event)}
        >
          <For each={visible()} keyed={(tab) => tab.tabId}>
            {(tab) => (
              <wa-tab
                class={[
                  "board-tabs__tab",
                  {
                    "board-tabs__tab--active": tab().tabId === props.activeTabId,
                    "board-tabs__tab--drop": tab().tabId === props.hoverTabId,
                  },
                ]}
                prop:panel={tab().tabId}
                prop:active={tab().tabId === props.activeTabId}
                data-board-tab-id={tab().tabId}
              >
                {tab().title}
              </wa-tab>
            )}
          </For>
        </wa-tab-group>
        <Show when={overflow().length > 0}>
          <wa-dropdown
            class="board-tabs__overflow"
            placement="bottom-end"
            onWa-select={(event) => props.onOverflowSelect(event)}
          >
            <button
              class="board-tabs__overflow-trigger"
              slot="trigger"
              type="button"
              aria-label={t("board.moreTabs")}
              title={t("board.moreTabs")}
            >
              •••
            </button>
            <For each={overflow()} keyed={(tab) => tab.tabId}>
              {(tab) => (
                <wa-dropdown-item
                  class="board-tabs__overflow-item"
                  value={tab().tabId}
                  data-board-tab-id={tab().tabId}
                >
                  {tab().title}
                </wa-dropdown-item>
              )}
            </For>
          </wa-dropdown>
        </Show>
      </nav>
    </Show>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-tab-group": HTMLAttributes<HTMLElementTagNameMap["wa-tab-group"]> &
        Properties<HTMLElementTagNameMap["wa-tab-group"]>;
      "wa-tab": HTMLAttributes<HTMLElementTagNameMap["wa-tab"]> &
        Properties<HTMLElementTagNameMap["wa-tab"]>;
    }
  }
}
