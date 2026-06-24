import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../api/types.ts";
import type { ApplicationSessions } from "../app/sessions.ts";
import { t } from "../i18n/index.ts";
import { formatDateTimeMs } from "../lib/format.ts";
import { isCronSessionKey, resolveSessionDisplayName } from "../lib/session-display.ts";
import { isSessionKeyTiedToAgent, isSubagentSessionKey } from "../lib/session-key.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { icons } from "./icons.ts";

const SEARCH_DEBOUNCE_MS = 300;

export class SessionPicker extends LitElement {
  @property({ attribute: false }) sessions?: ApplicationSessions;
  @property({ attribute: false }) sessionsResult: SessionsListResult | null = null;
  @property({ attribute: false }) currentSessionKey = "";
  @property({ attribute: false }) agentId = "main";
  @property({ attribute: false }) defaultAgentId = "main";
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) compact = false;
  @property({ attribute: false }) onSelectSession?: (sessionKey: string) => void;

  @state() private open = false;
  @state() private query = "";
  @state() private appliedQuery = "";
  @state() private result: SessionsListResult | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  private requestId = 0;
  private searchTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  override disconnectedCallback() {
    this.clearSearchTimer();
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("sessionsResult") && !this.appliedQuery) {
      this.result = this.sessionsResult;
    }
  }

  private clearSearchTimer() {
    if (this.searchTimer !== null) {
      globalThis.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  private toggle() {
    if (!this.connected) {
      return;
    }
    this.open = !this.open;
    if (this.open && !this.result) {
      this.result = this.sessionsResult;
    }
  }

  private close() {
    this.clearSearchTimer();
    this.open = false;
  }

  private scheduleSearch() {
    this.clearSearchTimer();
    this.searchTimer = globalThis.setTimeout(() => {
      this.searchTimer = null;
      void this.loadPage();
    }, SEARCH_DEBOUNCE_MS);
  }

  private async loadPage(options: { append?: boolean; offset?: number } = {}) {
    const sessions = this.sessions;
    if (!sessions || !this.connected) {
      return;
    }
    const requestId = ++this.requestId;
    this.loading = true;
    this.error = null;
    try {
      const page = await sessions.list({
        agentId: this.agentId,
        search: this.appliedQuery,
        offset: options.offset,
      });
      if (requestId !== this.requestId) {
        return;
      }
      this.result =
        options.append && this.result && page
          ? {
              ...page,
              count: this.result.sessions.length + page.sessions.length,
              sessions: [
                ...this.result.sessions,
                ...page.sessions.filter(
                  (row) => !this.result?.sessions.some((current) => current.key === row.key),
                ),
              ],
            }
          : page;
    } catch (error) {
      if (requestId === this.requestId) {
        this.error = String(error);
      }
    } finally {
      if (requestId === this.requestId) {
        this.loading = false;
      }
    }
  }

  private async applySearch() {
    this.clearSearchTimer();
    this.appliedQuery = normalizeOptionalString(this.query) ?? "";
    await this.loadPage();
  }

  private clearSearch() {
    this.clearSearchTimer();
    ++this.requestId;
    this.query = "";
    this.appliedQuery = "";
    this.error = null;
    this.result = this.sessionsResult;
    if (this.open) {
      void this.loadPage();
    }
  }

  private async loadMore() {
    const result = this.result;
    const offset =
      typeof result?.nextOffset === "number" && Number.isFinite(result.nextOffset)
        ? Math.max(0, Math.floor(result.nextOffset))
        : result?.hasMore
          ? result.sessions.length
          : null;
    if (offset === null || this.loading) {
      return;
    }
    await this.loadPage({ append: true, offset });
  }

  private rows() {
    const currentSessionKey = this.currentSessionKey;
    return (this.result?.sessions ?? []).filter((row) => {
      if (row.key === currentSessionKey) {
        return true;
      }
      return (
        !row.archived &&
        row.kind !== "global" &&
        row.kind !== "unknown" &&
        row.kind !== "cron" &&
        !isCronSessionKey(row.key) &&
        !isSubagentSessionKey(row.key) &&
        !row.spawnedBy &&
        isSessionKeyTiedToAgent(row.key, this.agentId, this.defaultAgentId)
      );
    });
  }

  private renderPicker() {
    if (!this.open) {
      return nothing;
    }
    const rows = this.rows();
    const hasQuery = Boolean(this.query || this.appliedQuery);
    const loadMore =
      this.result?.hasMore === true &&
      (typeof this.result.nextOffset === "number"
        ? this.result.nextOffset
        : this.result.sessions.length);
    const pickerId = "chat-session-picker-sidebar";
    return html`
      <div
        id=${pickerId}
        class="chat-session-picker"
        role="dialog"
        aria-label=${t("chat.selectors.session")}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            this.close();
          }
        }}
      >
        <div class="chat-session-picker__search-row">
          <label class="field chat-session-picker__search">
            <input
              data-chat-session-picker-search="true"
              type="search"
              placeholder=${t("chat.selectors.sessionSearch")}
              aria-label=${t("chat.selectors.sessionSearch")}
              .value=${this.query}
              ?disabled=${!this.connected}
              @input=${(event: Event) => {
                this.query = (event.target as HTMLInputElement).value;
                this.scheduleSearch();
              }}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void this.applySearch();
                }
              }}
            />
          </label>
          <button
            class="btn btn--ghost btn--icon chat-session-picker__icon-button"
            type="button"
            title=${t("common.search")}
            aria-label=${t("common.search")}
            ?disabled=${!this.connected}
            @click=${() => void this.applySearch()}
          >
            ${icons.search}
          </button>
          ${hasQuery
            ? html`
                <button
                  class="btn btn--ghost btn--icon chat-session-picker__icon-button"
                  type="button"
                  title=${t("chat.selectors.clearSessionSearch")}
                  aria-label=${t("chat.selectors.clearSessionSearch")}
                  @click=${this.clearSearch}
                >
                  ${icons.x}
                </button>
              `
            : nothing}
        </div>
        ${this.error
          ? html`<div class="chat-session-picker__status" role="alert">${this.error}</div>`
          : nothing}
        <div class="chat-session-picker__list" role="listbox">
          ${this.loading && rows.length === 0
            ? html`<div class="chat-session-picker__status">${t("common.loading")}</div>`
            : nothing}
          ${!this.loading && rows.length === 0
            ? html`<div class="chat-session-picker__status">${t("sessionsView.noSessions")}</div>`
            : nothing}
          ${repeat(
            rows,
            (row) => row.key,
            (row) => {
              const selected = row.key === this.currentSessionKey;
              const label = resolveSessionDisplayName(row.key, row);
              const meta = formatDateTimeMs(row.updatedAt, undefined, "");
              return html`
                <button
                  class="chat-session-picker__option ${selected
                    ? "chat-session-picker__option--selected"
                    : ""}"
                  data-chat-session-picker-option="true"
                  data-session-key=${row.key}
                  role="option"
                  aria-selected=${selected ? "true" : "false"}
                  title=${label}
                  type="button"
                  @click=${() => {
                    this.close();
                    if (!selected) {
                      this.onSelectSession?.(row.key);
                    }
                  }}
                >
                  <span class="chat-session-picker__option-main">
                    <span class="chat-session-picker__option-label">${label}</span>
                    ${meta
                      ? html`<span class="chat-session-picker__option-meta">${meta}</span>`
                      : nothing}
                  </span>
                  ${selected
                    ? html`<span class="chat-session-picker__option-check" aria-hidden="true">
                        ${icons.check}
                      </span>`
                    : nothing}
                </button>
              `;
            },
          )}
        </div>
        <div class="chat-session-picker__footer">
          <span class="chat-session-picker__count">${this.result?.totalCount ?? rows.length}</span>
          ${loadMore !== false && loadMore !== undefined
            ? html`
                <button
                  class="btn btn--ghost btn--sm"
                  type="button"
                  ?disabled=${this.loading}
                  @click=${() => void this.loadMore()}
                >
                  ${t("chat.selectors.loadMoreSessions")}
                </button>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  override render() {
    const selected = this.result?.sessions.find((row) => row.key === this.currentSessionKey);
    const selectedLabel = resolveSessionDisplayName(this.currentSessionKey, selected);
    return html`
      <div
        class="chat-controls__session-row chat-controls__session-row--session-switcher chat-controls__session-row--single-agent ${this
          .compact
          ? "chat-controls__session-row--compact"
          : ""}"
      >
        <div class="chat-controls__session chat-controls__session-picker">
          <button
            class="chat-controls__session-trigger"
            data-chat-session-select="true"
            type="button"
            title=${selectedLabel}
            aria-label=${t("chat.selectors.session")}
            aria-haspopup="dialog"
            aria-expanded=${this.open ? "true" : "false"}
            aria-controls="chat-session-picker-sidebar"
            ?disabled=${!this.connected}
            @click=${this.toggle}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                this.open = true;
              }
            }}
          >
            ${this.compact
              ? html`<span class="chat-controls__session-trigger-compact-icon" aria-hidden="true"
                  >${icons.messageSquare}</span
                >`
              : nothing}
            <span class="chat-controls__session-trigger-label">${selectedLabel}</span>
            <span class="chat-controls__session-trigger-icon" aria-hidden="true"
              >${icons.chevronDown}</span
            >
          </button>
          ${this.renderPicker()}
        </div>
      </div>
      <div class="chat-controls__session-notice" role="status" aria-live="polite"></div>
    `;
  }
}

if (!customElements.get("openclaw-session-picker")) {
  customElements.define("openclaw-session-picker", SessionPicker);
}
