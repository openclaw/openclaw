// Control UI component renders the standard routed page header.
import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";

export type PageHeaderProps = {
  title: string;
  subtitle: string;
  error: string | null;
  hidden: boolean;
  inert: boolean;
};

export class PageHeader extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: PageHeaderProps;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  override render() {
    const props = this.props;
    if (!props || props.hidden) {
      return nothing;
    }
    return html`
      <section
        class=${props.inert ? "content-header content-header--chat-hidden" : "content-header"}
        ?inert=${props.inert}
        aria-hidden=${props.inert ? "true" : nothing}
      >
        <div>
          <div class="page-title">${props.title}</div>
          <div class="page-sub">${props.subtitle}</div>
        </div>
        <div class="page-meta">
          ${props.error ? html`<div class="pill danger">${props.error}</div>` : nothing}
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-page-header")) {
  customElements.define("openclaw-page-header", PageHeader);
}
