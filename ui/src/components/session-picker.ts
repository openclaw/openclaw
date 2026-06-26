import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { formatDateTimeMs } from "../lib/format.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { getVisibleSessionRows, type SessionCapability } from "../lib/sessions/index.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

const SEARCH_DEBOUNCE_MS = 300;

export class SessionPicker extends LitElement {
  @property({ attribute: false }) sessions?: SessionCapability;
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
  private triggerElement: HTMLElement | null = null;

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (!this.open || event.defaultPrevented || event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.close({ restoreFocus: true });
  };

  private readonly handleDocumentPointerdown = (event: PointerEvent) => {
    if (!this.open || event.composedPath().includes(this)) {
      return;
    }
    this.close();
  };

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    document.addEventListener("pointerdown", this.handleDocumentPointerdown, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    document.removeEventListener("pointerdown", this.handleDocumentPointerdown, true);
    this.clearSearchTimer();
    this.triggerElement = null;
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("sessionsResult") && !this.result && !this.appliedQuery) {
      this.result = this.sessionsResult;
    }
  }

  override updated(changed: Map<PropertyKey, unknown>) {
    if (!changed.has("open") || !this.open) {
      return;
    }
    this.querySelector<HTMLInputElement>('[data-chat-session-picker-search="true"]')?.focus();
  }

  private clearSearchTimer() {
    if (this.searchTimer !== null) {
      globalThis.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  private openFromTrigger(trigger: HTMLElement) {
    if (!this.connected) {
      return;
    }
    this.triggerElement = trigger;
    this.open = true;
    if (!this.result) {
      this.result = this.sessionsResult;
    }
  }

  private toggle(trigger: HTMLElement) {
    if (this.open) {
      this.close({ restoreFocus: true });
      return;
    }
    this.openFromTrigger(trigger);
  }

  private close(options: { restoreFocus?: boolean } = {}) {
    this.clearSearchTimer();
    const focusTarget = options.restoreFocus ? this.triggerElement : null;
    this.open = false;
    this.triggerElement = null;
    if (!(focusTarget instanceof HTMLElement) || !focusTarget.isConnected) {
      return;
    }
    requestAnimationFrame(() => {
      if (focusTarget.isConnected) {
        focusTarget.focus();
      }
    });
  }

  private scheduleSearch() {
    this.clearSearchTimer();
    this.searchTimer = globalThis.setTimeout(() => {
      this.searchTimer = null;
      void this.applySearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  private async loadPage(options: { append?: boolean; offset?: number } = {}) {
    const sessionService = this.sessions;
    if (!sessionService || !this.connected) {
      return;
    }
    const requestId = ++this.requestId;
    this.loading = true;
    this.error = null;
    try {
      const page = await sessionService.list({
        agentId: this.agentId,
        search: this.appliedQuery,
        offset: options.offset,
      });
      if (requestId !== this.requestId) {
        return;
      }
      if (!page) {
        return;
      }
      if (!options.append || !this.result) {
        this.result = page;
        return;
      }
      const rowsByKey = new Set(this.result.sessions.map((row) => row.key));
      const combinedSessions = [
        ...this.result.sessions,
        ...page.sessions.filter((row) => !rowsByKey.has(row.key)),
      ];
      const totalCount = page.totalCount ?? this.result.totalCount;
      const hasMore =
        page.hasMore ??
        (typeof totalCount === "number" && Number.isFinite(totalCount)
          ? combinedSessions.length < totalCount
          : false);
      this.result = {
        ...page,
        count: combinedSessions.length,
        hasMore,
        nextOffset:
          page.nextOffset !== undefined
            ? page.nextOffset
            : hasMore
              ? combinedSessions.length
              : null,
        sessions: combinedSessions,
        totalCount,
      };
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
    if (this.loading) {
      return;
    }
    let result = this.result;
    let offset = this.resolveNextOffset(result);
    let visibleCount = this.rows().length;
    const seenOffsets = new Set<number>();
    while (offset !== null && !seenOffsets.has(offset)) {
      seenOffsets.add(offset);
      await this.loadPage({ append: true, offset });
      result = this.result;
      const nextVisibleCount = this.rows().length;
      if (nextVisibleCount > visibleCount) {
        return;
      }
      visibleCount = nextVisibleCount;
      offset = this.resolveNextOffset(result);
    }
  }

  private resolveNextOffset(result: SessionsListResult | null): number | null {
    if (!result?.hasMore) {
      return null;
    }
    if (typeof result.nextOffset === "number" && Number.isFinite(result.nextOffset)) {
      return Math.max(0, Math.floor(result.nextOffset));
    }
    return result.sessions.length;
  }

  private formatMeta(row: SessionsListResult["sessions"][number]): string {
    const parts = [
      normalizeOptionalString(row.surface),
      [normalizeOptionalString(row.modelProvider), normalizeOptionalString(row.model)]
        .filter(Boolean)
        .join("/"),
    ].filter(Boolean);
    const updatedAt = formatDateTimeMs(row.updatedAt, undefined, "");
    if (updatedAt) {
      parts.push(updatedAt);
    }
    return parts.join(" · ");
  }

  private countLabel(rows: SessionsListResult["sessions"]): string {
    const loadedCount = this.result?.sessions.length ?? 0;
    const totalCount = this.result?.totalCount;
    return loadedCount === rows.length &&
      typeof totalCount === "number" &&
      Number.isFinite(totalCount)
      ? `${rows.length} / ${totalCount}`
      : String(rows.length);
  }

  private rows() {
    return getVisibleSessionRows(this.result, {
      currentSessionKey: this.currentSessionKey,
      agentId: this.agentId,
      defaultAgentId: this.defaultAgentId,
    });
  }

  private renderPicker() {
    if (!this.open) {
      return nothing;
    }
    const rows = this.rows();
    const hasQuery = Boolean(this.query || this.appliedQuery);
    const searchPending =
      normalizeOptionalString(this.query) !== normalizeOptionalString(this.appliedQuery);
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
              @blur=${() => {
                if (normalizeOptionalString(this.query)) {
                  void this.applySearch();
                }
              }}
            />
          </label>
          <openclaw-tooltip .content=${t("common.search")}>
            <button
              class="btn btn--ghost btn--icon chat-session-picker__icon-button"
              data-chat-session-search-submit="true"
              type="button"
              aria-label=${t("common.search")}
              ?disabled=${!this.connected}
              @click=${() => void this.applySearch()}
            >
              ${icons.search}
            </button>
          </openclaw-tooltip>
          ${hasQuery
            ? html`
                <openclaw-tooltip .content=${t("chat.selectors.clearSessionSearch")}>
                  <button
                    class="btn btn--ghost btn--icon chat-session-picker__icon-button"
                    data-chat-session-search-clear="true"
                    type="button"
                    aria-label=${t("chat.selectors.clearSessionSearch")}
                    @click=${this.clearSearch}
                  >
                    ${icons.x}
                  </button>
                </openclaw-tooltip>
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
              const meta = this.formatMeta(row);
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
                    this.close({ restoreFocus: true });
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
          <span class="chat-session-picker__count">${this.countLabel(rows)}</span>
          ${loadMore !== false && loadMore !== undefined
            ? html`
                <button
                  class="btn btn--ghost btn--sm"
                  data-chat-session-load-more="true"
                  type="button"
                  ?disabled=${this.loading || searchPending}
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
            aria-label=${t("chat.selectors.session")}
            aria-haspopup="dialog"
            aria-expanded=${this.open ? "true" : "false"}
            aria-controls="chat-session-picker-sidebar"
            ?disabled=${!this.connected}
            @click=${(event: MouseEvent) => this.toggle(event.currentTarget as HTMLElement)}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                this.openFromTrigger(event.currentTarget as HTMLElement);
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
