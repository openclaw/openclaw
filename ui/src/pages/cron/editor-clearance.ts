import type { ReactiveController, ReactiveControllerHost } from "lit";

/** The sticky actions obscure part of the page's existing scrollport. */
export class CronEditorClearance implements ReactiveController {
  private footer: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private previousPadding = "";

  constructor(private readonly host: HTMLElement & ReactiveControllerHost) {
    host.addController(this);
  }

  hostUpdated() {
    const footer = this.host.querySelector<HTMLElement>(".cron-editor-actions");
    const scroller = this.host.closest<HTMLElement>(".content");
    if (footer === this.footer && scroller === this.scroller) {
      return;
    }
    this.hostDisconnected();
    if (!footer || !scroller) {
      return;
    }
    this.footer = footer;
    this.scroller = scroller;
    this.previousPadding = scroller.style.scrollPaddingBlockEnd;
    const measure = () => {
      const padding = getComputedStyle(scroller).paddingBlockEnd;
      scroller.style.scrollPaddingBlockEnd = `calc(${footer.getBoundingClientRect().height}px + ${padding})`;
    };
    measure();
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(measure);
      this.observer.observe(footer);
      this.observer.observe(scroller);
    }
  }

  hostDisconnected() {
    this.observer?.disconnect();
    this.observer = null;
    if (this.scroller) {
      this.scroller.style.scrollPaddingBlockEnd = this.previousPadding;
    }
    this.footer = null;
    this.scroller = null;
  }
}
