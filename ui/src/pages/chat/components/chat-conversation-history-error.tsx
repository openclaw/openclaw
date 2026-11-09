import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/chat/conversation-notices.css";

export function ChatConversationHistoryError(props: { message: string; onRetry: () => void }) {
  return (
    <div class="chat-history-error__stage" title={props.message} aria-description={props.message}>
      <svg class="chat-history-error__art" viewBox="0 0 112 88" fill="none" aria-hidden="true">
        <path
          d="M37 13h52a9 9 0 0 1 9 9v29a9 9 0 0 1-9 9h-5l-9 8v-8H37a9 9 0 0 1-9-9V22a9 9 0 0 1 9-9Z"
          fill="var(--bg-elevated)"
          stroke="var(--border)"
        />
        <path
          d="M22 29h47a9 9 0 0 1 9 9v25a9 9 0 0 1-9 9H34l-11 8v-8h-1a9 9 0 0 1-9-9V38a9 9 0 0 1 9-9Z"
          fill="var(--bg)"
          stroke="var(--muted)"
          stroke-opacity=".6"
        />
        <path
          d="M27 45h33M27 55h23"
          stroke="var(--muted)"
          stroke-opacity=".55"
          stroke-width="2"
          stroke-linecap="round"
        />
        <circle
          cx="82"
          cy="61"
          r="13"
          fill="var(--bg-elevated)"
          stroke="var(--bg)"
          stroke-width="4"
        />
        <path d="M82 55v6M82 66v.1" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" />
      </svg>
      <h2>{t("chat.historyUnavailableTitle")}</h2>
      <p>{props.message || t("chat.historyUnavailableBody")}</p>
      <button class="btn chat-history-error__retry" type="button" onClick={() => props.onRetry()}>
        <Icon name="refresh" />
        {t("common.retry")}
      </button>
    </div>
  );
}
