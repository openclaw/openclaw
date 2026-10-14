import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createMemo, Show, For } from "solid-js";
import type { SessionsSearchHit } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import { formatMs, formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";

registerCommandPaletteEnglish();

type TranscriptSearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "results";
      sessions: GatewaySessionRow[];
      results: SessionsSearchHit[];
      indexing: boolean;
      truncated: boolean;
      archivedTranscriptsExcluded: number;
    };

export type TranscriptSearchProps = {
  transcriptSearchAvailable: boolean;
  transcriptSearchQuery: string;
  transcriptSearch: TranscriptSearchState;
  onTranscriptSearchChange: (query: string) => void;
  onTranscriptSearch: () => void;
  onClearTranscriptSearch: () => void;
  onNavigateToChat: (sessionKey: string) => void;
};

export function TranscriptSearch(props: TranscriptSearchProps) {
  const query = createMemo(() => props.transcriptSearchQuery);
  const hasQuery = createMemo(() => query().trim().length > 0);
  const state = createMemo(() => props.transcriptSearch);
  const resultState = createMemo(() => {
    const current = props.transcriptSearch;
    return current.status === "results" ? current : null;
  });
  const results = createMemo(() => resultState()?.results ?? []);
  const rows = createMemo(() => resultState()?.sessions ?? []);
  const loading = createMemo(() => state().status === "loading");
  const retryNotice = createMemo(() => {
    const current = props.transcriptSearch;
    return current.status === "error"
      ? `${t("sessionsView.transcriptSearchError")}: ${current.message}`
      : current.status === "results" && current.indexing
        ? t("sessionsView.transcriptSearchIndexing")
        : null;
  });
  const retryStatus = createMemo(() => (retryNotice() === null ? null : state().status));
  return (
    <section
      class="sessions-transcript-search"
      aria-label={t("sessionsView.transcriptSearchTitle")}
    >
      <form
        class="sessions-transcript-search__form"
        role="search"
        aria-label={t("sessionsView.transcriptSearchTitle")}
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault();
          if (props.transcriptSearchAvailable && hasQuery() && !loading()) {
            props.onTranscriptSearch();
          }
        }}
      >
        <div class="data-table-search sessions-transcript-search__input">
          <input
            type="search"
            maxlength="4096"
            aria-label={t("sessionsView.transcriptSearchInputLabel")}
            placeholder={t("sessionsView.transcriptSearchPlaceholder")}
            value={query()}
            disabled={!props.transcriptSearchAvailable}
            onInput={(event) => props.onTranscriptSearchChange(event.currentTarget.value)}
          />
        </div>
        <button
          class="btn primary"
          type="submit"
          disabled={!props.transcriptSearchAvailable || !hasQuery() || loading()}
        >
          {loading()
            ? t("sessionsView.transcriptSearchSearching")
            : t("sessionsView.transcriptSearchAction")}
        </button>
        {hasQuery() ? (
          <button class="btn" type="button" onClick={props.onClearTranscriptSearch}>
            {t("sessionsView.transcriptSearchClear")}
          </button>
        ) : undefined}
      </form>
      {!props.transcriptSearchAvailable ? (
        <div class="muted" role="status">
          {t("sessionsView.transcriptSearchUnavailable")}
        </div>
      ) : undefined}
      <div
        class="sessions-transcript-search__status"
        aria-live="polite"
        aria-busy={loading() ? "true" : "false"}
      >
        {loading() ? (
          <span class="muted">{t("sessionsView.transcriptSearchSearching")}</span>
        ) : undefined}
        <Show when={retryStatus()} keyed>
          {(status) => (
            <div
              class={
                status === "error"
                  ? "sessions-transcript-search__notice sessions-transcript-search__notice--danger"
                  : "sessions-transcript-search__notice"
              }
            >
              <span>{retryNotice()}</span>
              <button class="btn btn--sm" type="button" onClick={props.onTranscriptSearch}>
                {t("sessionsView.transcriptSearchRetry")}
              </button>
            </div>
          )}
        </Show>
        {(resultState()?.archivedTranscriptsExcluded ?? 0) > 0 ? (
          <div class="sessions-transcript-search__notice">
            {t("sessionsView.transcriptSearchArchivedExcluded", {
              count: String(resultState()?.archivedTranscriptsExcluded),
            })}
          </div>
        ) : undefined}
        {resultState() && results().length === 0 && !resultState()?.indexing ? (
          <div class="sessions-transcript-search__empty" role="status">
            {t("sessionsView.transcriptSearchEmpty")}
          </div>
        ) : undefined}
        {results().length > 0 ? (
          <div class="sessions-transcript-search__results">
            <div class="sessions-transcript-search__summary">
              <strong>
                {t("sessionsView.transcriptSearchMatches", {
                  count: String(results().length),
                })}
              </strong>
              {resultState()?.truncated ? (
                <span class="muted">{t("sessionsView.transcriptSearchTruncated")}</span>
              ) : undefined}
            </div>
            <div class="sessions-transcript-search__list">
              <For each={results()}>
                {(hit) => {
                  const label = createMemo(() => {
                    const row = rows().find((candidate) => candidate.key === hit.sessionKey);
                    return (
                      normalizeOptionalString(row?.label) ??
                      normalizeOptionalString(row?.displayName) ??
                      hit.sessionKey
                    );
                  });
                  const timestamp = createMemo(() =>
                    hit.timestamp > 0 ? formatRelativeTimestamp(hit.timestamp) : t("common.na"),
                  );
                  const timestampTitle = createMemo(() =>
                    hit.timestamp > 0 ? formatMs(hit.timestamp) : timestamp(),
                  );
                  return (
                    <button
                      class="sessions-transcript-search__result"
                      type="button"
                      onClick={() => props.onNavigateToChat(hit.sessionKey)}
                    >
                      <span class="sessions-transcript-search__result-header">
                        <strong>{label()}</strong>
                        <span class="muted" title={timestampTitle()}>
                          {t(`sessionsView.${hit.role}`)} · {timestamp()}
                        </span>
                      </span>
                      <span class="sessions-transcript-search__snippet">{hit.snippet}</span>
                      <span class="sessions-transcript-search__key">{hit.sessionKey}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        ) : undefined}
      </div>
    </section>
  );
}
