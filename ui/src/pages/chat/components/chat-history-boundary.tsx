import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
// In-flow "earlier history" boundary rendered above the virtualized transcript.
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export type ChatHistoryBoundaryProps = {
  hasMore: boolean;
  loading: boolean;
  onShowEarlier: () => void;
};

// Must match the CSS `height` of .chat-history-boundary: the value becomes the
// virtualizer's scrollMargin, and any drift misaligns row offsets by the delta.
export const CHAT_HISTORY_BOUNDARY_HEIGHT_PX = 44;

export function ChatHistoryBoundary(props: ChatHistoryBoundaryProps) {
  const label = () =>
    props.loading ? t("chat.thread.loadingEarlier") : t("chat.thread.showEarlier");
  return (
    <div class={["chat-history-boundary", { "chat-history-boundary--loading": props.loading }]}>
      <span class="chat-history-boundary__line" aria-hidden="true" />
      <button
        class="chat-history-boundary__action"
        type="button"
        aria-disabled={props.loading ? "true" : undefined}
        aria-busy={props.loading ? "true" : "false"}
        aria-label={label()}
        onClick={() => {
          if (!props.loading) {
            props.onShowEarlier();
          }
        }}
      >
        <span role="status">{label()}</span>
      </button>
      <span class="chat-history-boundary__line" aria-hidden="true" />
    </div>
  );
}
