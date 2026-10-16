import { Show, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export function TranscriptSearch(props: {
  state: { searchOpen: boolean; searchQuery: string; searchFocusPending: boolean };
  requestUpdate: () => void;
  onClose: () => void;
}) {
  const query = createMemo(() => props.state.searchQuery);
  return (
    <Show when={props.state.searchOpen}>
      <div
        class="agent-chat__search-bar"
        onKeyDown={(event) => {
          if (
            event.key !== "Escape" ||
            event.defaultPrevented ||
            event.isComposing ||
            event.keyCode === 229
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }}
      >
        <Icon name="search" />
        <input
          type="text"
          placeholder={t("chat.thread.searchPlaceholder")}
          aria-label={t("chat.thread.search")}
          value={query()}
          ref={(element) => {
            if (!props.state.searchFocusPending) {
              return;
            }
            props.state.searchFocusPending = false;
            queueMicrotask(() => {
              if (element.isConnected) {
                element.focus({ preventScroll: true });
              }
            });
          }}
          onInput={(event) => {
            props.state.searchQuery = event.currentTarget.value;
            props.requestUpdate();
          }}
        />
        <openclaw-tooltip prop:content={t("chat.thread.closeSearch")}>
          <button
            class="btn btn--ghost"
            aria-label={t("chat.thread.closeSearch")}
            onClick={() => props.onClose()}
          >
            <Icon name="x" />
          </button>
        </openclaw-tooltip>
      </div>
    </Show>
  );
}
