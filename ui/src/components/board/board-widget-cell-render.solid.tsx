import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import type { BoardTab, BoardWidget } from "../../lib/board/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { BOARD_SIZE_PRESETS } from "./board-widget-cell-options.ts";

export function BoardWidgetMenu(props: {
  widget: BoardWidget;
  tabs: readonly BoardTab[];
  disabled: boolean;
  onSelect: (event: CustomEvent<{ item: { value?: string } }>) => void;
}) {
  return (
    <wa-dropdown
      class="board-widget__menu"
      placement="bottom-end"
      onWa-select={(event) => props.onSelect(event)}
    >
      <button
        class="board-widget__menu-trigger"
        slot="trigger"
        type="button"
        aria-label={t("board.widget.menuLabel")}
        title={t("board.widget.menuLabel")}
      >
        ⋮
      </button>
      <BoardWidgetMenuItems widget={props.widget} tabs={props.tabs} disabled={props.disabled} />
    </wa-dropdown>
  );
}

export function BoardWidgetMenuItems(props: {
  widget: BoardWidget;
  tabs: readonly BoardTab[];
  disabled: boolean;
  prefix?: string;
}) {
  const prefix = () => props.prefix ?? "";
  const tabs = () => props.tabs.filter((tab) => tab.tabId !== props.widget.tabId);
  return (
    <>
      <div class="board-widget__menu-heading">{t("board.widget.moveToTab")}</div>
      <Show
        when={tabs().length > 0}
        fallback={<span class="board-widget__menu-empty">{t("board.widget.noOtherTabs")}</span>}
      >
        <For keyed={false} each={tabs()}>
          {(tab) => (
            <wa-dropdown-item value={`${prefix()}move:${tab().tabId}`} disabled={props.disabled}>
              {tab().title}
            </wa-dropdown-item>
          )}
        </For>
      </Show>
      <div class="board-widget__menu-heading">{t("board.widget.resize")}</div>
      <For keyed={false} each={Object.entries(BOARD_SIZE_PRESETS)}>
        {(entry) => (
          <wa-dropdown-item
            class="board-widget__preset"
            value={`${prefix()}resize:${entry()[0]}`}
            disabled={props.disabled}
          >
            {entry()[0].toUpperCase()}
            <span slot="details">
              {entry()[1].w}×{entry()[1].h}
            </span>
          </wa-dropdown-item>
        )}
      </For>
      <Show when={props.widget.contentKind === "html"}>
        <wa-dropdown-item
          class="board-widget__preset"
          type="checkbox"
          value={`${prefix()}height:auto`}
          checked={props.widget.heightMode !== "fixed"}
          disabled={props.disabled}
        >
          {t("board.widget.autoHeight")}
        </wa-dropdown-item>
      </Show>
      <div class="board-widget__menu-separator" role="separator" />
      <wa-dropdown-item
        class="board-widget__menu-danger"
        value={`${prefix()}remove`}
        disabled={props.disabled}
      >
        <span slot="icon" class="board-widget__menu-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
          </svg>
        </span>
        {t("board.widget.remove")}
      </wa-dropdown-item>
    </>
  );
}

export function BoardWidgetRejected(props: { disabled: boolean; onRemove: () => void }) {
  return (
    <div class="board-widget__grant board-widget__grant--rejected" data-test-id="board-rejected">
      <strong>{t("board.widget.rejected")}</strong>
      <span>{t("board.widget.rejectedDetail")}</span>
      <button
        class="btn btn--small"
        type="button"
        disabled={props.disabled}
        onClick={() => props.onRemove()}
      >
        {t("board.widget.remove")}
      </button>
    </div>
  );
}

export function BoardDisabledPlugin(props: {
  pluginId: string;
  disabled: boolean;
  onRemove: () => void;
  children?: JSX.Element;
}) {
  return (
    <div class="board-widget__disabled-plugin" data-test-id="board-disabled-plugin">
      {props.children ?? (
        <strong>{t("board.widget.disabledPlugin", { pluginId: props.pluginId })}</strong>
      )}
      <button
        class="btn btn--small"
        type="button"
        disabled={props.disabled}
        onClick={() => props.onRemove()}
      >
        {t("board.widget.remove")}
      </button>
    </div>
  );
}

export function BoardWidgetError(props: {
  error: unknown;
  onRetry?: () => void;
  action?: boolean;
  inline?: boolean;
}) {
  return (
    <div
      class={[
        "board-widget__error",
        { "board-widget__error--inline": props.action && props.inline },
      ]}
      role="alert"
      data-test-id={props.action ? "board-widget-action-error" : "board-widget-error"}
    >
      <strong>
        {t(props.action ? "board.widget.actionErrorTitle" : "board.widget.errorTitle")}
      </strong>
      <span>{t(props.action ? "board.widget.actionErrorDetail" : "board.widget.errorDetail")}</span>
      <details>
        <summary>{t("board.widget.errorShow")}</summary>
        <code>{props.action ? String(props.error) : formatUiError(props.error)}</code>
      </details>
      <Show when={props.onRetry}>
        <button class="btn btn--small" type="button" onClick={() => props.onRetry?.()}>
          {t("board.widget.retry")}
        </button>
      </Show>
    </div>
  );
}
