/** Reserve the part of the existing scrollport obscured by sticky actions. */
export function reserveCronEditorClearance(host: HTMLElement): (() => void) | undefined {
  const footer = host.querySelector<HTMLElement>(".cron-editor-actions");
  const scroller = host.closest<HTMLElement>(".content");
  if (!footer || !scroller) {
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
}
