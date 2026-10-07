import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import type { ChatInputRegion } from "../../../app/chat-input-owner.ts";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { isSessionRunActive } from "../../../lib/session-run-state.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import type { PaneSessionChangeOptions } from "../chat-pane-shared.ts";
import { isUnfinishedSubagent } from "../chat-spawned-subagent.ts";
import { SubagentsPanelData, type SubagentsPanelRow } from "../subagents-panel-data.ts";
import "../../../components/elapsed-time.ts";
import "./chat-subagents-panel.css";

let panelSequence = 0;

class ChatSubagentsPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  protected context!: ApplicationContext;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId = "main";
  @property({ attribute: false }) paneId = "single";
  @property({ attribute: false }) presentationId = "single";
  @property({ attribute: false }) inputRegion: ChatInputRegion = "page";
  @property({ type: Boolean }) presented = true;
  /** The pane's request to show one subagent, or the list for null; taken once. */
  @property({ attribute: false }) showRequest?: () => string | null | undefined;
  @property({ attribute: false }) onSessionSelect?: (
    sessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => boolean | void;

  @state() private selected: { key: string; agentId: string } | null = null;
  @state() private finishedOpen = true;
  private readonly finishedId: string;
  private data: SubagentsPanelData | null = null;
  private dataContext: ApplicationContext | null = null;

  constructor() {
    super();
    panelSequence += 1;
    this.finishedId = `chat-subagents-finished-${panelSequence}`;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.data?.dispose();
    this.data = null;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const contextChanged = this.dataContext !== this.context;
    const parentChanged = changed.has("sessionKey") || changed.has("agentId");
    if (contextChanged || parentChanged) {
      this.selected = null;
    }
    if (contextChanged) {
      this.data?.dispose();
      this.data = null;
      this.dataContext = this.context;
    }
    if (this.context && !this.data) {
      this.data = new SubagentsPanelData(this.context, () => this.requestUpdate());
      this.syncData();
    } else if (parentChanged || changed.has("presented")) {
      this.syncData();
    }
    const requested = changed.has("showRequest") ? this.showRequest?.() : undefined;
    if (requested !== undefined) {
      this.selected = requested
        ? { key: requested, agentId: this.subagentAgentId(requested) }
        : null;
    }
    if (this.selected && this.data && !this.data.loading) {
      const denied = this.data.error && this.data.rows.length === 0;
      // An incomplete page cannot establish that a previously selected child was removed.
      const removed =
        this.data.hasResult &&
        !this.data.error &&
        !this.data.hasMore &&
        !this.data.rows.some((row) => row.session.key === this.selected?.key);
      if (denied || removed) {
        this.selected = null;
      }
    }
  }

  private syncData(): void {
    this.data?.sync({
      sessionKey: this.sessionKey,
      agentId: this.agentId,
      presented: this.presented,
    });
  }

  async refresh(): Promise<void> {
    await this.data?.refresh();
  }

  private subagentAgentId(key: string): string {
    const session = this.data?.rows.find((row) => row.session.key === key)?.session;
    return session?.agentId ?? parseAgentSessionKey(key)?.agentId ?? this.agentId;
  }

  private select(row: SubagentsPanelRow): void {
    this.selected = { key: row.session.key, agentId: this.subagentAgentId(row.session.key) };
  }

  private readonly backToSubagents = (): void => {
    this.selected = null;
  };

  private readonly navigateSession = (
    _paneId: string,
    sessionKey: string,
    options?: PaneSessionChangeOptions,
  ): boolean | void => this.onSessionSelect?.(sessionKey, options);

  private renderElapsed(row: SubagentsPanelRow) {
    const { session } = row;
    const running = isSessionRunActive(session);
    if (session.runtimeMs != null) {
      return running && session.runtimeSampledAt != null
        ? html`<openclaw-elapsed-time
            .startMs=${session.runtimeSampledAt - session.runtimeMs}
          ></openclaw-elapsed-time>`
        : formatDurationCompact(session.runtimeMs);
    }
    if (session.startedAt == null || (!running && session.endedAt == null)) {
      return nothing;
    }
    return html`<openclaw-elapsed-time
      .startMs=${session.startedAt}
      .endMs=${running ? null : session.endedAt}
    ></openclaw-elapsed-time>`;
  }

  private renderRow(row: SubagentsPanelRow) {
    const { session } = row;
    const running = isSessionRunActive(session);
    const title = resolveSessionDisplayName(session.key, session);
    const activity =
      session.status === "queued"
        ? t("common.queued")
        : running
          ? row.activity || row.toolDisplayName
          : undefined;
    const stopLabel = row.stopping
      ? t("chat.subagentsPanel.stopping")
      : t("chat.subagentsPanel.stop", { name: title });
    return html`<div class="chat-subagents__item" role="listitem" data-session-key=${session.key}>
      <div class="chat-subagents__item-heading">
        <button
          class="chat-subagents__open"
          type="button"
          title=${title}
          @click=${() => this.select(row)}
        >
          ${title}
        </button>
        ${
          running && session.activeRunIds?.length === 1
            ? html`<button
                class="chat-subagents__stop"
                type="button"
                aria-label=${stopLabel}
                title=${row.stopAccess.allowed ? stopLabel : row.stopAccess.reason}
                ?disabled=${row.stopping || !row.canStop}
                @click=${() => void this.data?.stop(row)}
              >
                ${icons.square}
              </button>`
            : nothing
        }
      </div>
      <div class="chat-subagents__metadata">
        <span class="chat-subagents__work">
          ${
            row.callCount === undefined
              ? nothing
              : html`<span class="chat-subagents__calls"
                  >${t(
                    row.callCount === 1
                      ? "chat.subagentsPanel.callsOne"
                      : "chat.subagentsPanel.callsMany",
                    { count: String(row.callCount) },
                  )}</span
                >`
          }
          ${row.callCount !== undefined && activity ? html`<span aria-hidden="true">·</span>` : nothing}
          ${activity ? html`<span class="chat-subagents__activity" title=${activity}>${activity}</span>` : nothing}
        </span>
        <span
          class="chat-subagents__elapsed"
          title=${t(running ? "chat.subagentsPanel.elapsed" : "chat.subagentsPanel.duration")}
          >${this.renderElapsed(row)}</span
        >
      </div>
    </div>`;
  }

  override render() {
    if (this.selected) {
      const { key, agentId } = this.selected;
      const detailId = `${this.presentationId}:subagent:${key}`;
      return keyed(
        detailId,
        html`<openclaw-chat-pane
          class="chat-subagents__detail-pane"
          .paneId=${this.paneId}
          .presentationId=${detailId}
          .sessionKey=${key}
          .agentId=${agentId}
          .inputRegion=${this.inputRegion}
          .compact=${true}
          .active=${false}
          .presented=${this.presented}
          .onBackToSubagents=${this.backToSubagents}
          .onPaneSessionChange=${this.navigateSession}
        ></openclaw-chat-pane>`,
      );
    }

    const rows = this.data?.rows ?? [];
    const unfinished = (row: SubagentsPanelRow) =>
      row.session.status === "queued" || isUnfinishedSubagent(row.session);
    const running = rows.filter(unfinished);
    const finished = rows.filter((row) => !unfinished(row));
    const loading = this.data?.loading ?? false;
    const empty = this.data?.hasResult && !this.data.hasMore && !this.data.error;
    return html`<div class="chat-subagents__list" aria-busy=${loading}>
      ${
        this.data?.error
          ? html`<div class="chat-subagents__error" role="alert">
              <span>${this.data.error}</span>
              <button class="btn btn--sm" type="button" @click=${() => this.refresh()}>
                ${t("common.retry")}
              </button>
            </div>`
          : nothing
      }
      ${
        !rows.length
          ? loading || empty
            ? html`<div class="chat-subagents__empty" role="status">
                ${loading ? t("common.loading") : t("chat.subagentsPanel.empty")}
              </div>`
            : nothing
          : html`
              <section class="chat-subagents__running">
                <h3 class="chat-subagents__section-title">
                  ${t("chat.subagentsPanel.running", { count: String(running.length) })}
                </h3>
                <div role="list">
                  ${repeat(
                    running,
                    (row) => row.session.key,
                    (row) => this.renderRow(row),
                  )}
                </div>
                ${running.length ? nothing : html`<div class="chat-subagents__empty">${t("chat.subagentsPanel.noRunning")}</div>`}
              </section>
              <section class="chat-subagents__finished">
                <button
                  class="chat-subagents__finished-toggle"
                  type="button"
                  aria-expanded=${this.finishedOpen}
                  aria-controls=${this.finishedId}
                  @click=${() => {
                    this.finishedOpen = !this.finishedOpen;
                  }}
                >
                  <span
                    >${t("chat.subagentsPanel.finished", { count: String(finished.length) })}</span
                  >
                  ${this.finishedOpen ? icons.chevronDown : icons.chevronRight}
                </button>
                <div id=${this.finishedId} role="list" ?hidden=${!this.finishedOpen}>
                  ${
                    this.finishedOpen
                      ? repeat(
                          finished,
                          (row) => row.session.key,
                          (row) => this.renderRow(row),
                        )
                      : nothing
                  }
                </div>
              </section>
            `
      }
      ${
        this.data?.hasMore
          ? html`<button
              class="chat-subagents__load-more btn btn--sm"
              type="button"
              ?disabled=${loading}
              @click=${() => this.data?.loadMore()}
            >
              ${loading ? t("common.loading") : t("chat.subagentsPanel.loadMore")}
            </button>`
          : nothing
      }
    </div>`;
  }
}

if (!customElements.get("openclaw-chat-subagents-panel")) {
  customElements.define("openclaw-chat-subagents-panel", ChatSubagentsPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-subagents-panel": ChatSubagentsPanel;
  }
}
