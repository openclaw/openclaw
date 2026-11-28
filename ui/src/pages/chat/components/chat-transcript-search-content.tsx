import { onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "../../../components/tooltip.ts";
import type { TranscriptSearchProps } from "./chat-transcript-search.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

export function TranscriptSearchContent(props: TranscriptSearchProps & { query: string }) {
  onSettled(() => {
    const search = props.search;
    let reading = false;
    const resume = async () => {
      if (reading || !search.snapshot.query.trim()) {
        return;
      }
      reading = true;
      try {
        while (search.resumeEarlierHistory === resume && search.snapshot.query.trim()) {
          const page = props.chat.historyPagination;
          const visibility = props.chat.transcriptVisible;
          const presented =
            typeof visibility === "object" ? visibility.isPresented() : visibility !== false;
          if (!presented || !page?.connected || page.error || !(await page.onSearchEarlier?.())) {
            break;
          }
        }
      } finally {
        reading = false;
      }
    };
    search.resumeEarlierHistory = resume;
    void resume();
    return () => {
      if (search.resumeEarlierHistory === resume) {
        search.resumeEarlierHistory = undefined;
      }
    };
  });

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
