/**
 * Base class for localized Lit elements.
 * Automatically re-renders when locale changes.
 */

import { LitElement } from "lit";

export class LocalizedElement extends LitElement {
  private boundLocaleHandler = this.handleLocaleChange.bind(this);

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("locale-changed", this.boundLocaleHandler);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("locale-changed", this.boundLocaleHandler);
  }

  private handleLocaleChange(): void {
    this.requestUpdate();
  }
}
