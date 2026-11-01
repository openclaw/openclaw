import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createDeferred } from "@solidjs/signals";
import {
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { RetryAction } from "../../components/solid/settings-ui.tsx";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatMs, formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { TranscriptSearchResult, TranscriptSearchState } from "./transcript-search.ts";

registerSessionOrganizationEnglish();

registerCommandPaletteEnglish();

export type TranscriptSearchProps = TranscriptSearchState & {
  transcriptSearchAvailable: boolean;
  onTranscriptSearchChange: (query: string) => void;
  onTranscriptSearch: () => void;
  onClearTranscriptSearch: () => void;
  onNavigateToChat: (sessionKey: string) => void;
};

type TranscriptSearchViewProps = TranscriptSearchProps & {
  /** The results slot consumes the owner-issued payload without issuing another read. */
  readSearch: () => TranscriptSearchResult | null;
};

export function TranscriptSearchForm(props: TranscriptSearchProps) {
  let input: HTMLInputElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  const [expanded, setExpanded] = createSignal(false);
  const query = createMemo(() => props.transcriptSearchQuery);
  const hasQuery = () => query().trim().length > 0;
  // The retained controls observe pending work without holding the results boundary.
  const search = createDeferred(() => props.transcriptSearch, { loadingValue: null });
  const loading = () => isPending(search);
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
              if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                !event.isComposing &&
                event.keyCode !== 229 &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey
              ) {
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

export function TranscriptSearchResults(props: TranscriptSearchViewProps) {
  return (
    <section
      class="sessions-transcript-search"
      aria-label={t("sessionsView.transcriptSearchTitle")}
    >
      <Errored
        fallback={(error, reset) => (
          <div class="sessions-transcript-search__status" aria-live="polite" aria-busy="false">
            <div class="sessions-transcript-search__notice sessions-transcript-search__notice--danger">
              <span>
                {t("sessionsView.transcriptSearchError")}: {formatUiError(error())}
              </span>
              <RetryAction
                type="button"
                label={t("sessionsView.transcriptSearchRetry")}
                onRetry={() => {
                  props.onTranscriptSearch();
                  reset();
                }}
              />
            </div>
          </div>
        )}
      >
        {/* Re-arm at issuance; a bare promise would make the dependency await its result. */}
        <Loading
          on={[props.transcriptSearch]}
          fallback={
            <div class="sessions-transcript-search__status" aria-live="polite" aria-busy="true">
              <span class="muted">{t("sessionsView.transcriptSearchSearching")}</span>
            </div>
          }
        >
          <TranscriptSearchContent {...props} />
        </Loading>
      </Errored>
    </section>
  );
}

function TranscriptSearchContent(props: TranscriptSearchViewProps) {
  const resultState = () => props.readSearch();
  const results = createMemo(() => resultState()?.results ?? []);
  const rows = createMemo(() => resultState()?.sessions ?? []);
  const retryNotice = () => {
    return resultState()?.indexing ? t("sessionsView.transcriptSearchIndexing") : null;
  };
  return (
    <div class="sessions-transcript-search__status" aria-live="polite" aria-busy="false">
      <Show when={retryNotice()}>
        <div class="sessions-transcript-search__notice">
          <span>{retryNotice()}</span>
          <RetryAction
            type="button"
            label={t("sessionsView.transcriptSearchRetry")}
            onRetry={() => props.onTranscriptSearch()}
          />
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
  );
}
