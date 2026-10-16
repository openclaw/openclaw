import { onSettled } from "solid-js";

/** Reserve the part of the existing scrollport obscured by sticky actions. */
export function createCronEditorClearance() {
  let footer!: HTMLElement;
  onSettled(() => {
    const scroller = footer.closest<HTMLElement>(".content");
    if (!scroller) {
      return undefined;
    }
    const previousPadding = scroller.style.scrollPaddingBlockEnd;
    const measure = () => {
      const padding = getComputedStyle(scroller).paddingBlockEnd;
      scroller.style.scrollPaddingBlockEnd = `calc(${footer.getBoundingClientRect().height}px + ${padding})`;
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(footer);
    observer?.observe(scroller);
    return () => {
      observer?.disconnect();
      scroller.style.scrollPaddingBlockEnd = previousPadding;
    };
  });
  return (element: HTMLElement) => {
    footer = element;
  };
}
