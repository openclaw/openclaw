import { html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";

// Mirrors renderCatalogCard's geometry (art tile, title, action slot, two summary
// lines) inside the real grid so the layout does not jump on load. Fills are kept
// light and sparse on purpose: eight cards of solid bars read as a wall.
export function renderCatalogGridSkeleton(params: {
  label?: string;
  cards: number;
}): TemplateResult {
  return html`<div
    class="plugin-catalog-grid plugin-catalog-grid--skeleton"
    role="status"
    aria-busy="true"
    aria-label=${params.label ?? t("common.loading")}
  >
    ${Array.from(
      { length: params.cards },
      () => html`<div
        class="plugin-catalog-card oc-card plugin-catalog-card--skeleton"
        aria-hidden="true"
      >
        <div class="plugin-catalog-card__head">
          <div class="installed-plugins-card__head">
            <span class="skeleton plugin-catalog-card__skeleton-art"></span>
            <div class="installed-plugins-card__identity">
              <span class="skeleton plugin-catalog-card__skeleton-title"></span>
            </div>
          </div>
          <div class="plugin-catalog-card__action">
            <span class="skeleton plugin-catalog-card__skeleton-action"></span>
          </div>
        </div>
        <span class="plugin-catalog-card__skeleton-summary">
          <span class="skeleton plugin-catalog-card__skeleton-line"></span>
          <span class="skeleton plugin-catalog-card__skeleton-line"></span>
        </span>
      </div>`,
    )}
  </div>`;
}

class PluginCatalogSkeleton extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) label = "";
  @state() private cards = 8;
  private observer?: ResizeObserver;
  private frame = 0;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("resize", this.scheduleMeasure);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(this.scheduleMeasure);
      this.observer.observe(this.closest(".plugin-catalog-results") ?? this);
    }
  }

  override disconnectedCallback() {
    this.observer?.disconnect();
    cancelAnimationFrame(this.frame);
    window.removeEventListener("resize", this.scheduleMeasure);
    super.disconnectedCallback();
  }

  private readonly scheduleMeasure = () => {
    // Changing the card count resizes our observed ancestor. Render on the next frame
    // so that change cannot feed back into the current ResizeObserver delivery.
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.measure);
  };

  private readonly measure = () => {
    const grid = this.querySelector<HTMLElement>(".plugin-catalog-grid");
    const card = grid?.firstElementChild;
    if (!grid || !card) {
      return;
    }
    const height = card.getBoundingClientRect().height;
    if (!height) {
      return;
    }
    // Search fills the remaining viewport; shelf skeletons keep their two-row limit.
    // Measure the real grid so zoom, category wrapping, and resize use the same geometry.
    const style = getComputedStyle(grid);
    const columns = style.gridTemplateColumns.split(" ").length;
    const gap = Number.parseFloat(style.rowGap) || 0;
    const remaining = innerHeight - Math.max(0, grid.getBoundingClientRect().top);
    this.cards = Math.max(1, Math.ceil((remaining + gap) / (height + gap))) * columns;
  };

  override render() {
    return renderCatalogGridSkeleton({ label: this.label, cards: this.cards });
  }
}

if (!customElements.get("openclaw-plugin-catalog-skeleton")) {
  customElements.define("openclaw-plugin-catalog-skeleton", PluginCatalogSkeleton);
}
