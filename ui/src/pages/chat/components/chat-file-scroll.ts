import { listen } from "../../../lib/reactive/listener.ts";

/** Binds fades to the existing reader scrollport; no scroll position or navigation state is stored. */
export function observeFileScroll(
  scroll: HTMLElement,
  content: HTMLElement,
  initiallyEnabled: boolean,
) {
  let enabled = initiallyEnabled;
  const update = () => measureFileScroll(scroll, enabled)();
  const observer = new ResizeObserver(update);
  observer.observe(scroll);
  if (content !== scroll) {
    observer.observe(content);
  }
  const stopScroll = listen(scroll, "scroll", update, { passive: true });
  update();
  return {
    setEnabled(next: boolean) {
      if (next === enabled) {
        return;
      }
      enabled = next;
      update();
    },
    destroy() {
      observer.disconnect();
      stopScroll();
      scroll.classList.remove("sidebar-file-mobile__scroll");
      scroll.removeAttribute("data-fade-top");
      scroll.removeAttribute("data-fade-bottom");
      scroll.style.removeProperty("--mobile-file-scrollbar-width");
    },
  };
}

// Shared read/write pair for native layout batches and the imperative code editor.
export function measureFileScroll(scroll: HTMLElement, enabled: boolean): () => void {
  const atTop = scroll.scrollTop > 1;
  const atBottom = scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 1;
  const scrollbarWidth = Math.max(0, scroll.offsetWidth - scroll.clientWidth);
  return () => {
    scroll.classList.toggle("sidebar-file-mobile__scroll", enabled);
    scroll.toggleAttribute("data-fade-top", enabled && atTop);
    scroll.toggleAttribute("data-fade-bottom", enabled && atBottom);
    scroll.style.setProperty("--mobile-file-scrollbar-width", String(scrollbarWidth) + "px");
  };
}
