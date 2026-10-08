import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { ProcessesPanelData } from "../processes-panel-data.ts";
import "../../../components/elapsed-time.ts";
import "./chat-session-panels.css";
import "./chat-processes-panel.css";

class ChatProcessesPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  protected context!: ApplicationContext;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId = "main";
  @property({ type: Boolean }) presented = true;
  @state() private selected: string | null = null;
  @state() private finishedOpen = false;
  private data: ProcessesPanelData | null = null;
  private dataContext: ApplicationContext | null = null;

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
      this.data = new ProcessesPanelData(this.context, () => this.requestUpdate());
      this.syncData();
    } else if (parentChanged || changed.has("presented")) {
      this.syncData();
    }
    if (this.data?.error && this.data.rows.length === 0) {
      this.selected = null;
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

  private status(row: SessionProcessSummary) {
    if (this.data?.stopping.has(row.instanceId)) {
      return t("chat.processesPanel.stopping");
    }
    return t(`chat.processesPanel.status.${row.status}`);
  }

  private elapsed(row: SessionProcessSummary) {
    if (row.status !== "running" && row.endedAt === undefined) {
      return nothing;
    }
    return html`<openclaw-elapsed-time
      .startMs=${row.startedAt}
      .endMs=${row.endedAt ?? null}
    ></openclaw-elapsed-time>`;
  }

  private stopButton(row: SessionProcessSummary, detail = false) {
    const stopping = this.data?.stopping.has(row.instanceId);
    return row.status === "running" && row.canStop
      ? html`<button
          class="chat-processes__stop"
          type="button"
          aria-label=${t("chat.processesPanel.stop", { name: row.name })}
          title=${t("chat.processesPanel.stop", { name: row.name })}
          ?disabled=${stopping}
          @click=${() => void this.data?.stop(row)}
        >
          ${icons.square}${detail ? t(stopping ? "chat.processesPanel.stopping" : "chat.runControls.stop") : nothing}
        </button>`
      : nothing;
  }

  private row(row: SessionProcessSummary) {
    return html`<div class="chat-processes__item" role="listitem" data-process-id=${row.processId}>
      <div class="chat-processes__heading">
        <button
          class="chat-processes__open"
          type="button"
          title=${row.name}
          @click=${() => {
            this.selected = row.instanceId;
          }}
        >
          ${row.name}
        </button>
        ${this.stopButton(row)}
      </div>
      <div class="chat-processes__metadata">
        <span class=${row.status === "failed" ? "chat-processes__failure" : ""}
          >${this.status(row)}${row.exitCode != null ? html` · ${t("chat.processesPanel.exitCode", { code: String(row.exitCode) })}` : nothing}</span
        >
        <span>${this.elapsed(row)}</span>
      </div>
    </div>`;
  }

  override render() {
    const data = this.data;
    const rows = data?.rows ?? [];
    // Omission from a bounded snapshot does not establish retention loss.
    const selected = rows.find((row) => row.instanceId === this.selected);
    const running = rows.filter((row) => row.status === "running");
    const finished = rows.filter((row) => row.status !== "running");
    const error = data?.error
      ? html`<div class="chat-processes__error" role="alert">
          ${data.error}<button class="btn btn--sm" type="button" @click=${() => this.refresh()}>
            ${t("common.retry")}
          </button>
        </div>`
      : nothing;
    if (this.selected) {
      return html`<div class="chat-processes__detail">
        <header class="chat-processes__detail-header">
          <button
            class="chat-processes__back"
            type="button"
            @click=${() => {
              this.selected = null;
            }}
          >
            ${icons.arrowLeft}${t("chat.processesPanel.back")}
          </button>
          ${selected ? html`<div class="chat-processes__heading"><strong>${selected.name}</strong>${this.stopButton(selected, true)}</div>` : nothing}
        </header>
        ${error}
        ${
          selected
            ? html`<div class="chat-processes__output">
                <div class="chat-processes__metadata">
                  <span>${this.status(selected)}</span><span>${this.elapsed(selected)}</span>
                </div>
                ${selected.exitCode != null ? html`<p class="chat-processes__note">${t("chat.processesPanel.exitCode", { code: String(selected.exitCode) })}</p>` : nothing}
                ${selected.exitReason ? html`<p class="chat-processes__note">${selected.exitReason}</p>` : nothing}
                <h3>${t("chat.processesPanel.output")}</h3>
                <pre>${selected.tail || t("chat.processesPanel.noOutput")}</pre>
                <p class="chat-processes__note">${t("chat.processesPanel.retention")}</p>
                ${selected.truncated ? html`<p class="chat-processes__note">${t("chat.processesPanel.outputTruncated")}</p>` : nothing}
              </div>`
            : html`<div class="chat-processes__empty" role="status">
                ${t(data?.loading ? "common.loading" : data?.hasResult ? (data.truncated ? "chat.processesPanel.omitted" : "chat.processesPanel.expired") : "chat.processesPanel.disconnected")}
              </div>`
        }
      </div>`;
    }
    return html`<div class="chat-processes__list" aria-busy=${data?.loading ?? false}>
      ${error}
      ${
        !rows.length
          ? html`<div class="chat-processes__empty" role="status">
              ${data?.loading ? t("common.loading") : data?.hasResult && !data.error ? t("chat.processesPanel.empty") : !data?.error ? t("chat.processesPanel.disconnected") : nothing}
            </div>`
          : html` <section class="chat-processes__running">
                <h3>${t("chat.processesPanel.running", { count: String(running.length) })}</h3>
                <div role="list">
                  ${repeat(
                    running,
                    (row) => row.instanceId,
                    (row) => this.row(row),
                  )}
                </div>
                ${running.length ? nothing : html`<div class="chat-processes__empty">${t("chat.processesPanel.noRunning")}</div>`}
              </section>
              <section class="chat-processes__finished">
                <button
                  class="chat-processes__finished-toggle"
                  type="button"
                  aria-expanded=${this.finishedOpen}
                  @click=${() => {
                    this.finishedOpen = !this.finishedOpen;
                  }}
                >
                  <span
                    >${t("chat.processesPanel.finished", { count: String(finished.length) })}</span
                  >${this.finishedOpen ? icons.chevronDown : icons.chevronRight}
                </button>
                <div role="list" ?hidden=${!this.finishedOpen}>
                  ${
                    this.finishedOpen
                      ? repeat(
                          finished,
                          (row) => row.instanceId,
                          (row) => this.row(row),
                        )
                      : nothing
                  }
                </div>
              </section>`
      }
      ${data?.truncated ? html`<p class="chat-processes__note">${t("chat.processesPanel.listTruncated")}</p>` : nothing}
    </div>`;
  }
}

if (!customElements.get("openclaw-chat-processes-panel")) {
  customElements.define("openclaw-chat-processes-panel", ChatProcessesPanel);
}
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-processes-panel": ChatProcessesPanel;
  }
}
