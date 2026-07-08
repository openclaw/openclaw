// Composer-inline plan-approval card (Codex "Implement this plan?" swap-in).
//
// Shown in the chat composer status-stack while a plan is pending_approval. Approve
// and Revise-with-feedback route through the existing plan resolve path
// (/plan accept | /plan reject <feedback>) — no new approval API.
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

type InlinePlanApprovalProps = {
  summary?: string | null;
  busy?: boolean;
  onApprove: () => void;
  onRevise: (feedback: string) => void;
};

class InlinePlanApproval extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: InlinePlanApprovalProps;

  @state() private revising = false;
  @state() private feedback = "";

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  private approve(): void {
    if (this.props?.busy) {
      return;
    }
    this.props?.onApprove();
  }

  private sendRevision(): void {
    if (this.props?.busy) {
      return;
    }
    this.props?.onRevise(this.feedback.trim());
    this.feedback = "";
    this.revising = false;
  }

  private renderDefaultActions() {
    return html`
      <div class="inline-plan-approval__actions">
        <button
          class="btn btn--sm primary"
          type="button"
          data-plan-approve="true"
          ?disabled=${this.props?.busy}
          @click=${() => this.approve()}
        >
          ${icons.check} ${t("plan.approveCta")}
        </button>
        <button
          class="btn btn--sm"
          type="button"
          data-plan-revise="true"
          ?disabled=${this.props?.busy}
          @click=${() => {
            this.revising = true;
          }}
        >
          ${t("plan.revise")}
        </button>
      </div>
    `;
  }

  private renderReviseForm() {
    return html`
      <div class="inline-plan-approval__revise">
        <textarea
          class="inline-plan-approval__feedback"
          rows="2"
          placeholder=${t("plan.revisePlaceholder")}
          .value=${this.feedback}
          ?disabled=${this.props?.busy}
          @input=${(event: Event) => {
            this.feedback = (event.target as HTMLTextAreaElement).value;
          }}
        ></textarea>
        <div class="inline-plan-approval__actions">
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${this.props?.busy}
            @click=${() => {
              this.revising = false;
              this.feedback = "";
            }}
          >
            ${t("plan.cancel")}
          </button>
          <button
            class="btn btn--sm primary"
            type="button"
            data-plan-revise-submit="true"
            ?disabled=${this.props?.busy}
            @click=${() => this.sendRevision()}
          >
            ${t("plan.reviseSubmit")}
          </button>
        </div>
      </div>
    `;
  }

  override render() {
    if (!this.props) {
      return nothing;
    }
    return html`
      <section
        class="inline-plan-approval"
        data-plan-approval="true"
        role="group"
        aria-label=${t("plan.approveTitle")}
      >
        <header class="inline-plan-approval__header">
          <span class="inline-plan-approval__icon" aria-hidden="true">${icons.scrollText}</span>
          <span class="inline-plan-approval__title">${t("plan.approveTitle")}</span>
        </header>
        ${this.props.summary
          ? html`<p class="inline-plan-approval__summary">${this.props.summary}</p>`
          : nothing}
        ${this.revising ? this.renderReviseForm() : this.renderDefaultActions()}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-inline-plan-approval")) {
  customElements.define("openclaw-inline-plan-approval", InlinePlanApproval);
}

export type { InlinePlanApprovalProps, InlinePlanApproval };
