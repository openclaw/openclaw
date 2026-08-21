/** Ref callback that marks single-line text only while it is genuinely clipped. */
export function createOverflowFadeRef() {
  let target: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;

  const sync = () => {
    if (!target) {
      return;
    }
    const content = target.querySelector<HTMLElement>(".sidebar-recent-session__name-content");
    const contentWidth = content?.scrollWidth ?? target.scrollWidth;
    const revealDistance = Math.max(0, contentWidth - target.clientWidth);
    target.toggleAttribute("data-overflow-fade", revealDistance > 1);
    target.toggleAttribute("data-overflow-reveal", revealDistance > 1);
    if (revealDistance <= 1) {
      target.style.removeProperty("--overflow-reveal-translate");
      target.style.removeProperty("--overflow-reveal-duration");
      return;
    }
    const direction = getComputedStyle(target).direction === "rtl" ? 1 : -1;
    target.style.setProperty("--overflow-reveal-translate", `${direction * revealDistance}px`);
    const revealDuration = Math.min(8_000, Math.max(1_200, revealDistance * 16));
    target.style.setProperty("--overflow-reveal-duration", `${revealDuration}ms`);
  };

  return (element?: Element) => {
    const next = element instanceof HTMLElement ? element : null;
    if (next === target) {
      sync();
      return;
    }
    observer?.disconnect();
    target = next;
    observer = null;
    if (!target) {
      return;
    }
    sync();
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(sync);
      observer.observe(target);
    }
    queueMicrotask(sync);
  };
}
