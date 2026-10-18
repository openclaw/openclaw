/** Binds fades to the existing reader scrollport; no scroll position or navigation state is stored. */
export function observeFileScroll(
  scroll: HTMLElement,
  content: HTMLElement,
  initiallyEnabled: boolean,
) {
  let enabled = initiallyEnabled;
  const update = () => {
    scroll.classList.toggle("sidebar-file-mobile__scroll", enabled);
    scroll.toggleAttribute("data-fade-top", enabled && scroll.scrollTop > 1);
    scroll.toggleAttribute(
      "data-fade-bottom",
      enabled && scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 1,
    );
    scroll.style.setProperty(
      "--mobile-file-scrollbar-width",
      `${Math.max(0, scroll.offsetWidth - scroll.clientWidth)}px`,
    );
  };
  const observer = new ResizeObserver(update);
  observer.observe(scroll);
  if (content !== scroll) {
    observer.observe(content);
  }
  scroll.addEventListener("scroll", update, { passive: true });
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
      scroll.removeEventListener("scroll", update);
      scroll.classList.remove("sidebar-file-mobile__scroll");
      scroll.removeAttribute("data-fade-top");
      scroll.removeAttribute("data-fade-bottom");
      scroll.style.removeProperty("--mobile-file-scrollbar-width");
    },
  };
}
