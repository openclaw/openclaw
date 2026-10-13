import { createMemo, Show } from "solid-js";
import { formatWebUiIconErrorText } from "../../../components/error-presentation.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";

type ChatRunFailureNoticeProps = {
  summary: string;
  onRetry?: () => void;
  onChangeModel?: () => void;
};

/** One terminal notice, separate from assistant prose and preserved partial output. */
defineSolidBridge<ChatRunFailureNoticeProps>(
  "openclaw-chat-run-failure-notice",
  (props) => {
    const detail = createMemo(() => formatWebUiIconErrorText(props.summary).trim());
    const concise = createMemo(() => {
      const firstLine = detail().split(/\r?\n/u)[0] ?? "";
      return firstLine.length <= 240 ? firstLine : t("chat.recovery.failedHelp");
    });
    return (
      <div class="chat-run-failure" role="status">
        <span class="chat-run-failure__icon" aria-hidden="true">
          <Icon name="circleX" />
        </span>
        <div class="chat-run-failure__content">
          <strong class="chat-run-failure__title">{t("chat.recovery.failedTitle")}</strong>
          <p class="chat-run-failure__summary">{concise()}</p>
          <div class="chat-run-failure__actions">
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
            <Show when={props.onChangeModel}>
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                onClick={() => props.onChangeModel?.()}
              >
                {t("chat.recovery.changeModel")}
              </button>
            </Show>
          </div>
          <details class="chat-run-failure__details">
            <summary>{t("chat.details")}</summary>
            <p>{t("chat.recovery.failedHelp")}</p>
            <pre tabindex="0" aria-label={t("chat.errorDetails")}>
              {detail()}
            </pre>
            <CopyButton text={props.summary} idleLabel={t("chat.copyError")} />
          </details>
        </div>
      </div>
    );
  },
  {
    properties: {
      summary: { default: "" },
      onRetry: { default: undefined, attribute: false },
      onChangeModel: { default: undefined, attribute: false },
    },
    connected: (host) => (host.style.display = "contents"),
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-run-failure-notice": SolidBridgeElement<ChatRunFailureNoticeProps>;
  }
}
