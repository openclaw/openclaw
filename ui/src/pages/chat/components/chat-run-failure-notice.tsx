import { createMemo, Show } from "solid-js";
import { formatWebUiIconErrorText } from "../../../components/error-presentation.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";

/** One terminal notice, separate from assistant prose and preserved partial output. */
export function ChatRunFailureNotice(props: { summary: string; onRetry?: () => void }) {
  const detail = createMemo(() => formatWebUiIconErrorText(props.summary).trim());
  const concise = createMemo(() => {
    const firstLine = detail().split(/\r?\n/u)[0] ?? "";
    return firstLine.length <= 240 ? firstLine : t("chat.recovery.failedHelp");
  });
  return (
    <openclaw-chat-run-failure-notice style={{ display: "contents" }}>
      <div class="chat-run-failure" role="status">
        <span class="chat-run-failure__icon" aria-hidden="true">
          <Icon name="circleX" />
        </span>
        <div class="chat-run-failure__content">
          <div class="chat-run-failure__header">
            <div class="chat-run-failure__heading">
              <strong class="chat-run-failure__title">{t("chat.recovery.failedTitle")}</strong>
              <span class="chat-run-failure__copy">
                <CopyButton text={props.summary} idleLabel={t("chat.copyError")} bare />
              </span>
            </div>
            <Show when={props.onRetry}>
              <button
                type="button"
                class="btn primary btn--sm chat-run-failure__retry"
                onClick={() => props.onRetry?.()}
              >
                <Icon name="refresh" />
                {t("chat.recovery.tryAgain")}
              </button>
            </Show>
          </div>
          <p class="chat-run-failure__summary">{concise()}</p>
          <Show when={detail() !== concise()}>
            <details class="chat-run-failure__details">
              <summary>{t("chat.details")}</summary>
              <p>{t("chat.recovery.failedHelp")}</p>
              <pre tabindex="0" aria-label={t("chat.errorDetails")}>
                {detail()}
              </pre>
            </details>
          </Show>
        </div>
      </div>
    </openclaw-chat-run-failure-notice>
  );
}
