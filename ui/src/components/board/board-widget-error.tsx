import { Show } from "solid-js";
import { registerBoardEnglish } from "../../i18n/locales/en-board.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerBoardEnglish);

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
