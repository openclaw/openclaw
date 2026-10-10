import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

type SessionPanelData = {
  dispose(): void;
  sync(input: { sessionKey: string; agentId: string; presented: boolean }): void;
  refresh(): Promise<void>;
};

/** The panel owns presentation lifetime; each data owner retains its own admission policy. */
export abstract class ChatSessionPanel<
  Data extends SessionPanelData,
> extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  protected context!: ApplicationContext;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId = "main";
  @property({ type: Boolean }) presented = true;
  protected abstract clearSelection(): void;
  protected abstract finishedOpen: boolean;
  protected abstract readonly dataType: new (
    context: ApplicationContext,
    changed: () => void,
  ) => Data;
  protected data: Data | null = null;
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
      this.clearSelection();
    }
    if (contextChanged) {
      this.data?.dispose();
      this.data = null;
      this.dataContext = this.context;
    }
    const createData = this.context && !this.data;
    if (createData) {
      this.data = new this.dataType(this.context, () => this.requestUpdate());
    }
    if (createData || parentChanged || changed.has("presented")) {
      this.data?.sync({
        sessionKey: this.sessionKey,
        agentId: this.agentId,
        presented: this.presented,
      });
    }
  }

  async refresh(): Promise<void> {
    await this.data?.refresh();
  }

  protected renderGroups<Row>(
    kind: "processes" | "subagents",
    running: Row[],
    finished: Row[],
    keyFor: (row: Row) => unknown,
    renderRow: (row: Row) => unknown,
    finishedId?: string,
  ) {
    const prefix = `chat-${kind}`;
    const renderRows = (rows: Row[]) => repeat(rows, keyFor, renderRow);
    return html`
      <section class="${prefix}__running">
        <h3 class=${ifDefined(kind === "subagents" ? `${prefix}__section-title` : undefined)}>
          ${t(`chat.${kind}Panel.running`, { count: String(running.length) })}
        </h3>
        <div role="list">${renderRows(running)}</div>
        ${running.length ? nothing : html`<div class="${prefix}__empty">${t(`chat.${kind}Panel.noRunning`)}</div>`}
      </section>
      <section class="${prefix}__finished">
        <button
          class="${prefix}__finished-toggle"
          type="button"
          aria-expanded=${this.finishedOpen}
          aria-controls=${ifDefined(finishedId)}
          @click=${() => {
            this.finishedOpen = !this.finishedOpen;
          }}
        >
          <span>${t(`chat.${kind}Panel.finished`, { count: String(finished.length) })}</span>
          ${this.finishedOpen ? icons.chevronDown : icons.chevronRight}
        </button>
        <div id=${ifDefined(finishedId)} role="list" ?hidden=${!this.finishedOpen}>
          ${this.finishedOpen ? renderRows(finished) : nothing}
        </div>
      </section>
    `;
  }
}
