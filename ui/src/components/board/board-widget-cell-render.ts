import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
export type { BoardWidgetPageMenu } from "./board-widget-cell-options.ts";

export function renderBoardWidgetError(
  error: unknown,
  options: { onRetry?: () => void } = {},
): TemplateResult {
  return html`
    <div class="board-widget__error" role="alert" data-test-id="board-widget-error">
      <strong>${t("board.widget.errorTitle")}</strong>
      <span>${t("board.widget.errorDetail")}</span>
      <details>
        <summary>${t("board.widget.errorShow")}</summary>
        <code>${formatUiError(error)}</code>
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
