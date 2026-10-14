import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { dynamic, type JSX } from "@solidjs/web";
import { createEffect, For, Show } from "solid-js";
import type { BoardTab, BoardWidget } from "../../lib/board/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "../solid/icon.tsx";
import { BOARD_SIZE_PRESETS } from "./board-widget-cell-options.ts";

export function BoardCoreWidget(props: {
  tagName?: string;
  widget?: BoardWidget;
  session?: BoardGetParams;
  active: boolean;
}) {
  const Element = dynamic(() => props.tagName);
  let element!: HTMLElement & {
    widget?: BoardWidget;
    session?: BoardGetParams;
    active?: boolean;
  };
  createEffect(
    () => ({ widget: props.widget, session: props.session, active: props.active }),
    (value) => {
      element.widget = value.widget;
      element.session = value.session ?? { sessionKey: "" };
      element.active = value.active;
    },
  );
  return (
    <Element
      ref={(node: typeof element) => {
        element = node;
      }}
    />
  );
}

// The unported chat header still embeds these rows in its Web Awesome menu.
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
            <wa-dropdown-item
              value={`${prefix()}move:${tab().tabId}`}
              prop:disabled={props.disabled}
            >
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
            prop:disabled={props.disabled}
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
          prop:type="checkbox"
          value={`${prefix()}height:auto`}
          prop:checked={props.widget.heightMode !== "fixed"}
          prop:disabled={props.disabled}
        >
          {t("board.widget.autoHeight")}
        </wa-dropdown-item>
      </Show>
      <div class="board-widget__menu-separator" role="separator" />
      <wa-dropdown-item
        class="board-widget__menu-danger"
        value={`${prefix()}remove`}
        prop:disabled={props.disabled}
      >
        <span slot="icon" class="board-widget__menu-icon" aria-hidden="true">
          <Icon name="trash" />
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
