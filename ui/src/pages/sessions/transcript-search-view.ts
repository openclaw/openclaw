import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import type { SessionsSearchHit } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import { formatMs, formatRelativeTimestamp } from "../../lib/format.ts";

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
  onNavigateToChat?: (sessionKey: string) => void;
};

function transcriptSearchSessionLabel(hit: SessionsSearchHit, rows: GatewaySessionRow[]): string {
  const row = rows.find((candidate) => candidate.key === hit.sessionKey);
  return (
    normalizeOptionalString(row?.label) ??
    normalizeOptionalString(row?.displayName) ??
    hit.sessionKey
  );
}

export function renderTranscriptSearch(props: TranscriptSearchProps) {
  const hasQuery = props.transcriptSearchQuery.trim().length > 0;
  const state = props.transcriptSearch;
  const results = state.status === "results" ? state.results : [];
  const rows = state.status === "results" ? state.sessions : [];
  const loading = state.status === "loading";
  return html`
    <section
      class="sessions-transcript-search"
      aria-label=${t("sessionsView.transcriptSearchTitle")}
    >
      <form
        class="sessions-transcript-search__form"
        role="search"
        aria-label=${t("sessionsView.transcriptSearchTitle")}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          if (props.transcriptSearchAvailable && hasQuery && !loading) {
            props.onTranscriptSearch();
          }
        }}
      >
        <div class="data-table-search sessions-transcript-search__input">
          <input
            type="search"
            maxlength="4096"
            aria-label=${t("sessionsView.transcriptSearchInputLabel")}
            placeholder=${t("sessionsView.transcriptSearchPlaceholder")}
            .value=${props.transcriptSearchQuery}
            ?disabled=${!props.transcriptSearchAvailable}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                props.onTranscriptSearchChange(event.currentTarget.value);
              }
            }}
          />
        </div>
        <button
          class="btn primary"
          type="submit"
          ?disabled=${!props.transcriptSearchAvailable || !hasQuery || loading}
        >
          ${
            loading
              ? t("sessionsView.transcriptSearchSearching")
              : t("sessionsView.transcriptSearchAction")
          }
        </button>
        ${
          hasQuery
            ? html`
                <button class="btn" type="button" @click=${props.onClearTranscriptSearch}>
                  ${t("sessionsView.transcriptSearchClear")}
                </button>
              `
            : nothing
        }
      </form>
      ${
        !props.transcriptSearchAvailable
          ? html`
              <div class="muted" role="status">
                ${t("sessionsView.transcriptSearchUnavailable")}
              </div>
            `
          : nothing
      }
      <div
        class="sessions-transcript-search__status"
        aria-live="polite"
        aria-busy=${loading ? "true" : "false"}
      >
        ${
          loading
            ? html`<span class="muted">${t("sessionsView.transcriptSearchSearching")}</span>`
            : nothing
        }
        ${
          state.status === "error"
            ? html`
                <div
                  class="sessions-transcript-search__notice sessions-transcript-search__notice--danger"
                >
                  <span>${t("sessionsView.transcriptSearchError")}: ${state.message}</span>
                  <button class="btn btn--sm" type="button" @click=${props.onTranscriptSearch}>
                    ${t("sessionsView.transcriptSearchRetry")}
                  </button>
                </div>
              `
            : nothing
        }
        ${
          state.status === "results" && state.indexing
            ? html`
                <div class="sessions-transcript-search__notice">
                  <span>${t("sessionsView.transcriptSearchIndexing")}</span>
                  <button
                    class="btn btn--sm"
                    type="button"
                    ?disabled=${loading}
                    @click=${props.onTranscriptSearch}
                  >
                    ${t("sessionsView.transcriptSearchRetry")}
                  </button>
                </div>
              `
            : nothing
        }
        ${
          state.status === "results" && state.archivedTranscriptsExcluded > 0
            ? html`<div class="sessions-transcript-search__notice">
                ${t("sessionsView.transcriptSearchArchivedExcluded", {
                  count: String(state.archivedTranscriptsExcluded),
                })}
              </div>`
            : nothing
        }
        ${
          state.status === "results" && results.length === 0 && !state.indexing
            ? html`
                <div class="sessions-transcript-search__empty" role="status">
                  ${t("sessionsView.transcriptSearchEmpty")}
                </div>
              `
            : nothing
        }
        ${
          results.length > 0
            ? html`
                <div class="sessions-transcript-search__results">
                  <div class="sessions-transcript-search__summary">
                    <strong
                      >${t("sessionsView.transcriptSearchMatches", {
                        count: String(results.length),
                      })}</strong
                    >
                    ${
                      state.status === "results" && state.truncated
                        ? html`<span class="muted"
                            >${t("sessionsView.transcriptSearchTruncated")}</span
                          >`
                        : nothing
                    }
                  </div>
                  <div class="sessions-transcript-search__list">
                    ${results.map((hit) => {
                      const timestamp =
                        hit.timestamp > 0 ? formatRelativeTimestamp(hit.timestamp) : t("common.na");
                      const timestampTitle =
                        hit.timestamp > 0 ? formatMs(hit.timestamp) : timestamp;
                      return html`
                        <button
                          class="sessions-transcript-search__result"
                          type="button"
                          @click=${() => props.onNavigateToChat?.(hit.sessionKey)}
                        >
                          <span class="sessions-transcript-search__result-header">
                            <strong>${transcriptSearchSessionLabel(hit, rows)}</strong>
                            <span class="muted" title=${timestampTitle}>
                              ${t(`sessionsView.${hit.role}`)} · ${timestamp}
                            </span>
                          </span>
                          <span class="sessions-transcript-search__snippet">${hit.snippet}</span>
                          <span class="sessions-transcript-search__key">${hit.sessionKey}</span>
                        </button>
                      `;
                    })}
                  </div>
                </div>
              `
            : nothing
        }
      </div>
    </section>
  `;
}
