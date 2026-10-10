import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { ChatInputRegion } from "../../../app/chat-input-owner.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { isSessionRunActive } from "../../../lib/session-run-state.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import type { PaneSessionChangeOptions } from "../chat-pane-shared.ts";
import { isUnfinishedSubagent } from "../chat-spawned-subagent.ts";
import { SubagentsPanelData, type SubagentsPanelRow } from "../subagents-panel-data.ts";
import { ChatSessionPanel } from "./chat-session-panel.ts";
import "../../../components/elapsed-time.ts";
import "./chat-session-panels.css";
import "./chat-subagents-panel.css";

let panelSequence = 0;

class ChatSubagentsPanel extends ChatSessionPanel<SubagentsPanelData> {
  @property({ attribute: false }) paneId = "single";
  @property({ attribute: false }) presentationId = "single";
  @property({ attribute: false }) inputRegion: ChatInputRegion = "page";
  /** The pane's request to show one subagent, or the list for null; taken once. */
  @property({ attribute: false }) showRequest?: () => string | null | undefined;
  @property({ attribute: false }) onSessionSelect?: (
    sessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => boolean | void;

  @state() private selected: { key: string; agentId: string } | null = null;
  @state() protected finishedOpen = true;
  private readonly finishedId: string;
  protected readonly dataType = SubagentsPanelData;

  constructor() {
    super();
    panelSequence += 1;
    this.finishedId = `chat-subagents-finished-${panelSequence}`;
  }

  protected override clearSelection(): void {
    this.selected = null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    const requested = changed.has("showRequest") ? this.showRequest?.() : undefined;
    if (requested !== undefined) {
      this.selected = requested
        ? { key: requested, agentId: this.subagentAgentId(requested) }
        : null;
    }
    if (this.selected && this.data && !this.data.loading) {
      const denied = this.data.error && this.data.rows.length === 0;
      const removed =
        this.data.hasResult &&
        !this.data.error &&
        !this.data.rows.some((row) => row.session.key === this.selected?.key);
      if (denied || removed) {
        this.selected = null;
      }
    }
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
    const empty = this.data?.hasResult && !this.data.error;
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
          : this.renderGroups(
              "subagents",
              running,
              finished,
              (row) => row.session.key,
              (row) => this.renderRow(row),
              this.finishedId,
            )
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
