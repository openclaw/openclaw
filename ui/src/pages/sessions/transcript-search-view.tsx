import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { SessionsSearchHit } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { formatMs, formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";

registerSessionOrganizationEnglish();

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

export function TranscriptSearchForm(props: TranscriptSearchProps) {
  let input: HTMLInputElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  const [expanded, setExpanded] = createSignal(false);
  const query = createMemo(() => props.transcriptSearchQuery);
  const hasQuery = createMemo(() => query().trim().length > 0);
  const loading = createMemo(() => props.transcriptSearch.status === "loading");
  return (
    <form
      class="sessions-transcript-search__form"
      role="search"
      aria-label={t("sessionsView.transcriptSearchTitle")}
      onSubmit={(event: SubmitEvent) => {
        event.preventDefault();
        if (props.transcriptSearchAvailable && hasQuery() && !loading()) {
          props.onTranscriptSearch();
        } else {
          input?.focus({ preventScroll: true });
        }
      }}
    >
      <Show when={expanded()}>
        <div class="data-table-search sessions-transcript-search__input">
          <input
            ref={(element) => (input = element)}
            id="sessions-transcript-search-input"
            type="search"
            maxlength="4096"
            aria-label={t("sessionsView.transcriptSearchInputLabel")}
            placeholder={t("sessionsView.transcriptSearchPlaceholder")}
            value={query()}
            onInput={(event) => props.onTranscriptSearchChange(event.currentTarget.value)}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setExpanded(false);
                onSettled(() => trigger?.focus({ preventScroll: true }));
              }
            }}
          />
          <Show when={hasQuery()}>
            <button
              class="sessions-transcript-search__clear"
              type="button"
              aria-label={t("sessionsView.transcriptSearchClear")}
              onClick={() => {
                props.onClearTranscriptSearch();
                input?.focus({ preventScroll: true });
              }}
            >
              <Icon name="x" />
            </button>
          </Show>
        </div>
      </Show>
      <button
        ref={(element) => (trigger = element)}
        class="btn btn--xs btn--icon sessions-toolbar__icon sessions-transcript-search__trigger"
        type="submit"
        aria-label={
          props.transcriptSearchAvailable
            ? t("sessionsView.transcriptSearchTitle")
            : t("sessionsView.transcriptSearchUnavailable")
        }
        aria-controls="sessions-transcript-search-input"
        aria-expanded={expanded() ? "true" : "false"}
        disabled={!props.transcriptSearchAvailable || loading()}
        onClick={(event: MouseEvent) => {
          if (!expanded()) {
            event.preventDefault();
            setExpanded(true);
            onSettled(() => input?.focus({ preventScroll: true }));
          }
        }}
      >
        <Icon name="search" />
      </button>
    </form>
  );
}

export function TranscriptSearchResults(props: TranscriptSearchProps) {
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
      <div
        class="sessions-transcript-search__status"
        aria-live="polite"
        aria-busy={loading() ? "true" : "false"}
      >
        {loading() ? (
          <span class="muted">{t("sessionsView.transcriptSearchSearching")}</span>
        ) : undefined}
        <Show when={retryStatus()}>
          <div
            class={[
              "sessions-transcript-search__notice",
              { "sessions-transcript-search__notice--danger": retryStatus() === "error" },
            ]}
          >
            <span>{retryNotice()}</span>
            <button class="btn btn--sm" type="button" onClick={() => props.onTranscriptSearch()}>
              {t("sessionsView.transcriptSearchRetry")}
            </button>
          </div>
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
