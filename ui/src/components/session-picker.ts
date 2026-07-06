import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../lib/format.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  compareSessionRowsByUpdatedAt,
  getVisibleSessionRows,
  type SessionCapability,
} from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  canArchiveSessionRow,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

const SEARCH_DEBOUNCE_MS = 300;
const SESSION_PICKER_ID = "chat-session-picker-sidebar";

export class SessionPicker extends LitElement {
  @property({ attribute: false }) sessions?: SessionCapability;
  @property({ attribute: false }) sessionsResult: SessionsListResult | null = null;
  @property({ attribute: false }) currentSessionKey = "";
  @property({ attribute: false }) agentId = "main";
  @property({ attribute: false }) defaultAgentId = "main";
  @property({ attribute: false }) mainKey = "main";
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) onSelectSession?: (sessionKey: string) => void;
  @property({ attribute: false }) onReplaceCurrentSession?: (sessionKey: string) => void;

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
    if (changed.has("sessionsResult") && !this.appliedQuery) {
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
      if (!this.result) {
        void this.loadPage();
      }
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
    }).toSorted(compareSessionRowsByUpdatedAt);
  }

  private async patchSession(
    row: SessionsListResult["sessions"][number],
    patch: { label?: string | null; archived?: boolean; pinned?: boolean },
  ) {
    const sessions = this.sessions;
    if (!sessions || !this.connected) {
      return;
    }
    this.error = null;
    try {
      const agentId = parseAgentSessionKey(row.key)?.agentId ?? this.agentId;
      const patched = await sessions.patch(row.key, patch, { agentId });
      if (!patched) {
        this.error = sessions.state.error;
        return;
      }
      if (patch.archived === true && areUiSessionKeysEquivalent(row.key, this.currentSessionKey)) {
        this.close();
        this.onReplaceCurrentSession?.(
          buildAgentMainSessionKey({
            agentId,
            mainKey: this.mainKey,
          }),
        );
        return;
      }
      this.result = sessions.state.result ?? this.result;
      if (this.appliedQuery) {
        await this.loadPage();
      }
    } catch (error) {
      this.error = String(error);
    }
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
    return html`
      <div
        id=${SESSION_PICKER_ID}
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
                if (this.open && normalizeOptionalString(this.query)) {
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
                    @click=${() => this.clearSearch()}
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
              const selected = areUiSessionKeysEquivalent(row.key, this.currentSessionKey);
              const label = resolveSessionDisplayName(row.key, row);
              const meta = this.formatMeta(row);
              const pinned = row.pinned === true;
              const running = row.hasActiveRun === true;
              const archiveAllowed = canArchiveSessionRow(row, this.mainKey);
              const rowClass = [
                "chat-session-picker__option-row",
                "session-row-host",
                selected ? "chat-session-picker__option-row--selected" : "",
                pinned ? "session-row-host--pinned" : "",
                running ? "session-row-host--running" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return html`
                <div class=${rowClass}>
                  <button
                    class="chat-session-picker__option"
                    data-chat-session-picker-option="true"
                    data-session-key=${row.key}
                    role="option"
                    aria-selected=${selected ? "true" : "false"}
                    title=${meta}
                    type="button"
                    @click=${() => {
                      this.close({ restoreFocus: true });
                      this.onSelectSession?.(row.key);
                    }}
                  >
                    ${row.unread === true
                      ? html`<span
                          class="session-unread-dot chat-session-picker__unread"
                          role="img"
                          aria-label=${t("sessionsView.unread")}
                        ></span>`
                      : nothing}
                    <span class="chat-session-picker__option-label">${label}</span>
                  </button>
                  <span class="session-row-aside">
                    <span class="session-row-trail">
                      ${running
                        ? html`<span
                            class="session-run-spinner"
                            role="img"
                            aria-label=${t("sessionsView.activeRun")}
                            title=${t("sessionsView.activeRun")}
                          ></span>`
                        : formatRelativeTimestamp(row.updatedAt, { fallback: "" })}
                    </span>
                    <span class="session-row-actions">
                      <button
                        class="session-action"
                        data-chat-session-rename="true"
                        type="button"
                        title=${t("sessionsView.renameSession")}
                        aria-label=${t("sessionsView.renameSession")}
                        ?disabled=${!this.connected}
                        @click=${() => {
                          const nextLabel = window.prompt(
                            t("sessionsView.renameSessionPrompt"),
                            row.label ?? label,
                          );
                          if (nextLabel !== null) {
                            void this.patchSession(row, {
                              label: normalizeOptionalString(nextLabel) ?? null,
                            });
                          }
                        }}
                      >
                        ${icons.edit}
                      </button>
                      <button
                        class="session-action"
                        data-chat-session-archive="true"
                        type="button"
                        title=${t("sessionsView.archiveSession")}
                        aria-label=${t("sessionsView.archiveSession")}
                        ?disabled=${!this.connected || !archiveAllowed}
                        @click=${() => void this.patchSession(row, { archived: true })}
                      >
                        ${icons.archive}
                      </button>
                      <button
                        class="session-action session-action--pin"
                        data-chat-session-pin="true"
                        type="button"
                        title=${pinned
                          ? t("sessionsView.unpinSession")
                          : t("sessionsView.pinSession")}
                        aria-label=${pinned
                          ? t("sessionsView.unpinSession")
                          : t("sessionsView.pinSession")}
                        ?disabled=${!this.connected}
                        @click=${() => void this.patchSession(row, { pinned: !pinned })}
                      >
                        ${icons.pin}
                      </button>
                    </span>
                  </span>
                </div>
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
    const label = t("chat.selectors.sessionSearch");
    return html`
      <div class="sidebar-session-search">
        <button
          class="sidebar-session-search__button"
          type="button"
          title=${label}
          aria-label=${label}
          aria-haspopup="dialog"
          aria-expanded=${this.open ? "true" : "false"}
          aria-controls=${SESSION_PICKER_ID}
          ?disabled=${!this.connected}
          @click=${(event: MouseEvent) => this.toggle(event.currentTarget as HTMLElement)}
        >
          ${icons.search}
        </button>
        ${this.renderPicker()}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-session-picker")) {
  customElements.define("openclaw-session-picker", SessionPicker);
}
