import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
// In-flow "earlier history" boundary rendered above the virtualized transcript.
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export type ChatHistoryBoundaryProps = {
  hasMore: boolean;
  loading: boolean;
  connected?: boolean;
  error?: string | null;
  onShowEarlier: () => void;
};

// Keep every outcome the same height: the virtualizer uses this as scrollMargin.
export const CHAT_HISTORY_BOUNDARY_HEIGHT_PX = 80;

export function ChatHistoryBoundary(props: ChatHistoryBoundaryProps) {
  const unavailable = () => props.connected === false;
  const blocked = () => props.loading || unavailable();
  const label = () => {
    if (unavailable()) {
      return t("chat.thread.earlierConnecting");
    }
    if (props.loading) {
      return t("chat.thread.loadingEarlier");
    }
    return props.error ? t("chat.thread.retryEarlier") : t("chat.thread.showEarlier");
  };
  return (
    <div
      class={[
        "chat-history-boundary",
        {
          "chat-history-boundary--loading": props.loading,
          "chat-history-boundary--error": Boolean(props.error) && !blocked(),
        },
      ]}
    >
      <span class="chat-history-boundary__line" aria-hidden="true" />
      <button
        class="chat-history-boundary__action"
        type="button"
        aria-disabled={blocked() ? "true" : undefined}
        aria-busy={props.loading ? "true" : "false"}
        aria-label={label()}
        onClick={() => {
          if (!blocked()) {
            props.onShowEarlier();
          }
        }}
      >
        <span role="status">{label()}</span>
      </button>
      <span
        class="chat-history-boundary__line chat-history-boundary__line--trailing"
        aria-hidden="true"
      />
      <span
        class="chat-history-boundary__status"
        role={props.error && !blocked() ? "alert" : undefined}
        title={props.error ?? undefined}
      >
        {props.error && !blocked()
          ? t("chat.thread.earlierUnavailable")
          : t("chat.thread.earlierHint")}
      </span>
    </div>
  );
}
