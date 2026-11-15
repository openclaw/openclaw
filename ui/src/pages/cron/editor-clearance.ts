import { onSettled } from "solid-js";
import { createResizeObserver } from "../../lib/reactive/observers.ts";

/** Reserve the part of the existing scrollport obscured by sticky actions. */
export function createCronEditorClearance() {
  let footer!: HTMLElement;
  const measure = () => {
    const scroller = footer.closest<HTMLElement>(".content");
    if (!scroller) {
      return;
    }
    const padding = getComputedStyle(scroller).paddingBlockEnd;
    scroller.style.scrollPaddingBlockEnd = `calc(${footer.getBoundingClientRect().height}px + ${padding})`;
  };
  createResizeObserver(() => {
    const scroller = footer.closest<HTMLElement>(".content");
    return scroller ? [footer, scroller] : [footer];
  }, measure);
  onSettled(() => {
    const scroller = footer.closest<HTMLElement>(".content");
    if (!scroller) {
      return undefined;
    }
    const previousPadding = scroller.style.scrollPaddingBlockEnd;
    measure();
    return () => {
      scroller.style.scrollPaddingBlockEnd = previousPadding;
    };
  });
  return (element: HTMLElement) => {
    footer = element;
  };
}
