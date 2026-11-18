import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "../../../components/tooltip.ts";
import type { TranscriptSearchState } from "./chat-transcript-search-state.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export function TranscriptSearchContent(props: { search: TranscriptSearchState; query: string }) {
  return (
    <>
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
          props.search.close();
        }}
      >
        <Icon name="search" />
        <input
          type="text"
          placeholder={t("chat.thread.searchPlaceholder")}
          aria-label={t("chat.thread.search")}
          value={props.query}
          ref={(element) => props.search.focusInput(element)}
          onInput={(event) => props.search.setQuery(event.currentTarget.value)}
        />
        <openclaw-tooltip prop:content={t("chat.thread.closeSearch")}>
          <button
            class="btn btn--ghost"
            aria-label={t("chat.thread.closeSearch")}
            onClick={() => props.search.close()}
          >
            <Icon name="x" />
          </button>
        </openclaw-tooltip>
      </div>
    </>
  );
}
