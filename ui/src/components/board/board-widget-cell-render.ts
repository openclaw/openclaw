import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { BoardTab, BoardWidget } from "../../lib/board/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { icons } from "../icons.ts";
import { BOARD_SIZE_PRESETS } from "./board-widget-cell-options.ts";
export type { BoardWidgetPageMenu } from "./board-widget-cell-options.ts";

export function renderBoardWidgetMenuItems(options: {
  widget: BoardWidget;
  tabs: readonly BoardTab[];
  disabled: boolean;
  prefix?: string;
}): TemplateResult {
  const { widget, tabs, disabled, prefix = "" } = options;
  const otherTabs = tabs.filter((tab) => tab.tabId !== widget.tabId);
  return html`
    <div class="board-widget__menu-heading">${t("board.widget.moveToTab")}</div>
    ${
      otherTabs.length > 0
        ? otherTabs.map(
            (tab) => html`
              <wa-dropdown-item value=${`${prefix}move:${tab.tabId}`} ?disabled=${disabled}>
                ${tab.title}
              </wa-dropdown-item>
            `,
          )
        : html`<span class="board-widget__menu-empty">${t("board.widget.noOtherTabs")}</span>`
    }
    <div class="board-widget__menu-heading">${t("board.widget.resize")}</div>
    ${Object.entries(BOARD_SIZE_PRESETS).map(
      ([label, size]) => html`
        <wa-dropdown-item
          class="board-widget__preset"
          value=${`${prefix}resize:${label}`}
          ?disabled=${disabled}
        >
          ${label.toUpperCase()}
          <span slot="details">${size.w}×${size.h}</span>
        </wa-dropdown-item>
      `,
    )}
    ${
      widget.contentKind === "html"
        ? html`<wa-dropdown-item
            class="board-widget__preset"
            type="checkbox"
            value=${`${prefix}height:auto`}
            ?checked=${widget.heightMode !== "fixed"}
            ?disabled=${disabled}
          >
            ${t("board.widget.autoHeight")}
          </wa-dropdown-item>`
        : nothing
    }
    <div class="board-widget__menu-separator" role="separator"></div>
    <wa-dropdown-item
      class="board-widget__menu-danger"
      value=${`${prefix}remove`}
      ?disabled=${disabled}
    >
      <span slot="icon" class="board-widget__menu-icon" aria-hidden="true">${icons.trash}</span>
      ${t("board.widget.remove")}
    </wa-dropdown-item>
  `;
}

export function renderBoardWidgetError(
  error: unknown,
  options: { onRetry?: () => void; action?: boolean; inline?: boolean } = {},
): TemplateResult {
  return html`
    <div
      class=${`board-widget__error${options.action ? ` ${options.inline ? "board-widget__error--inline" : ""}` : ""}`}
      role="alert"
      data-test-id=${options.action ? "board-widget-action-error" : "board-widget-error"}
    >
      <strong
        >${t(options.action ? "board.widget.actionErrorTitle" : "board.widget.errorTitle")}</strong
      >
      <span
        >${t(options.action ? "board.widget.actionErrorDetail" : "board.widget.errorDetail")}</span
      >
      <details>
        <summary>${t("board.widget.errorShow")}</summary>
        <code>${options.action ? error : formatUiError(error)}</code>
      </details>
      ${
        options.onRetry
          ? html`<button class="btn btn--small" type="button" @click=${options.onRetry}>
              ${t("board.widget.retry")}
            </button>`
          : nothing
      }
    </div>
  `;
}
