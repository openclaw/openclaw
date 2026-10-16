import type { JSX } from "@solidjs/web";
import { createSignal, onSettled } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import "./custom-elements.ts";

// Mirrors renderCatalogCard's geometry (art tile, title, action slot, two summary
// lines) inside the real grid so the layout does not jump on load. Fills are kept
// light and sparse on purpose: eight cards of solid bars read as a wall.
export function renderCatalogGridSkeleton(params: { label?: string; cards: number }): JSX.Element {
  return (
    <div
      class="plugin-catalog-grid plugin-catalog-grid--skeleton"
      role="status"
      aria-busy="true"
      aria-label={params.label ?? t("common.loading")}
    >
      {Array.from({ length: params.cards }, () => (
        <div class="plugin-catalog-card oc-card plugin-catalog-card--skeleton" aria-hidden="true">
          <div class="plugin-catalog-card__head">
            <div class="installed-plugins-card__head">
              <span class="skeleton plugin-catalog-card__skeleton-art" />
              <div class="installed-plugins-card__identity">
                <span class="skeleton plugin-catalog-card__skeleton-title" />
              </div>
            </div>
            <div class="plugin-catalog-card__action">
              <span class="skeleton plugin-catalog-card__skeleton-action" />
            </div>
          </div>
          <span class="plugin-catalog-card__skeleton-summary">
            <span class="skeleton plugin-catalog-card__skeleton-line" />
            <span class="skeleton plugin-catalog-card__skeleton-line" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function PluginCatalogSkeleton(props: { label?: string }): JSX.Element {
  let host!: HTMLElement;
  const [cards, setCards] = createSignal(8);
  onSettled(() => {
    let frame = 0;
    const measure = () => {
      const grid = host.querySelector<HTMLElement>(".plugin-catalog-grid");
      const card = grid?.firstElementChild;
      if (!grid || !card) {
        return;
      }
      const height = card.getBoundingClientRect().height;
      if (!height) {
        return;
      }
      const style = getComputedStyle(grid);
      const columns = style.gridTemplateColumns.split(" ").length;
      const gap = Number.parseFloat(style.rowGap) || 0;
      const remaining = innerHeight - Math.max(0, grid.getBoundingClientRect().top);
      setCards(Math.max(1, Math.ceil((remaining + gap) / (height + gap))) * columns);
    };
    // Card-count writes can resize the observed ancestor; defer the next measurement.
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleMeasure) : undefined;
    observer?.observe(host.closest(".plugin-catalog-results") ?? host);
    window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleMeasure);
    };
  });
  return (
    <openclaw-plugin-catalog-skeleton
      ref={(element) => {
        host = element;
      }}
      style={{ display: "contents" }}
    >
      {renderCatalogGridSkeleton({ label: props.label ?? "", cards: cards() })}
    </openclaw-plugin-catalog-skeleton>
  );
}
