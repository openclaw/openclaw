import type { JSX } from "@solidjs/web";
import { createSignal, onSettled } from "solid-js";
import { listen } from "../../lib/reactive/listener.ts";
import { createResizeObserver } from "../../lib/reactive/observers.ts";
import { renderCatalogGridSkeleton } from "./catalog-grid.tsx";
import "./custom-elements.ts";

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
