import type { JSX } from "@solidjs/web";
import { createSignal, onSettled, Repeat } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createResizeObserver } from "../../lib/reactive/observers.ts";
import "./custom-elements.ts";

// Mirrors renderCatalogCard's geometry (art tile, title, action slot, two summary
// lines) inside the real grid so the layout does not jump on load. Fills are kept
// light and sparse on purpose: eight cards of solid bars read as a wall.
export function renderCatalogGridSkeleton(params: {
  label?: string;
  cards: number;
  ref?: (element: HTMLDivElement) => void;
}): JSX.Element {
  return (
    <div
      ref={(element) => params.ref?.(element)}
      class="plugin-catalog-grid plugin-catalog-grid--skeleton"
      role="status"
      aria-busy="true"
      aria-label={params.label ?? t("common.loading")}
    >
      <Repeat count={params.cards}>
        {() => (
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
        )}
      </Repeat>
    </div>
  );
}

export function PluginCatalogSkeleton(props: { label?: string }): JSX.Element {
  let host!: HTMLElement;
  let grid!: HTMLDivElement;
  const [cards, setCards] = createSignal(8);
  let frame = 0;
  const measure = () => {
    const card = grid.firstElementChild;
    if (!card) {
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
  createResizeObserver(() => [host.closest(".plugin-catalog-results") ?? host], scheduleMeasure);
  onSettled(() => {
    const stopResize = listen(window, "resize", scheduleMeasure);
    scheduleMeasure();
    return () => {
      cancelAnimationFrame(frame);
      stopResize();
    };
  });
  return (
    <openclaw-plugin-catalog-skeleton
      ref={(element) => {
        host = element;
      }}
      style={{ display: "contents" }}
    >
      {renderCatalogGridSkeleton({
        label: props.label ?? "",
        cards: cards(),
        ref: (el) => (grid = el),
      })}
    </openclaw-plugin-catalog-skeleton>
  );
}
