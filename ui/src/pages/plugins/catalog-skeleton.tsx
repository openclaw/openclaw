import type { JSX } from "@solidjs/web";
import { Repeat } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";

export function CatalogSkeletonCards(props: { count: number }): JSX.Element {
  return (
    <Repeat count={props.count}>
      {() => (
        <div class="plugin-catalog-card plugin-catalog-card--skeleton" aria-hidden="true">
          <div class="plugin-catalog-row__main">
            <span class="skeleton plugin-catalog-card__skeleton-art" />
            <span class="plugin-catalog-row__text">
              <span class="skeleton plugin-catalog-card__skeleton-title" />
              <span class="skeleton plugin-catalog-card__skeleton-line" />
            </span>
            <span class="skeleton plugin-catalog-card__skeleton-action" />
          </div>
        </div>
      )}
    </Repeat>
  );
}

// Mirrors the catalog row's geometry (art tile, title, summary line, action slot)
// inside the real grid so the layout does not jump on load. Fills are kept
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
      <CatalogSkeletonCards count={params.cards} />
    </div>
  );
}
