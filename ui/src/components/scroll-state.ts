import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";

class ScrollStateDirective extends AsyncDirective {
  private element: HTMLElement | undefined;
  private horizontal = false;
  private trackScroll = true;
  private pending = false;
  private readonly sync = () => {
    const element = this.element;
    if (!this.isConnected || !element?.isConnected) {
      return;
    }
    const size = this.horizontal ? element.scrollWidth : element.scrollHeight;
    const viewport = this.horizontal ? element.clientWidth : element.clientHeight;
    const position = this.horizontal ? element.scrollLeft : element.scrollTop;
    const scrollable = size > viewport + 1;
    element.dataset.scrollable = String(scrollable);
    element.dataset.atStart = String(!scrollable || position <= 1);
    element.dataset.atEnd = String(!scrollable || position + viewport >= size - 1);
  };
  private readonly observer =
    typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(this.sync);

  render(_horizontal = false, _trackScroll = true) {
    return nothing;
  }

  override update(
    part: ElementPart,
    [horizontal = false, trackScroll = true]: [boolean?, boolean?],
  ) {
    this.element = part.element instanceof HTMLElement ? part.element : undefined;
    this.horizontal = horizontal;
    this.trackScroll = trackScroll;
    this.schedule();
    return nothing;
  }

  private schedule(): void {
    if (this.pending || !this.isConnected) {
      return;
    }
    this.pending = true;
    // Element directives run before children commit. Measure the completed content,
    // including retained DOM updates, and fence work when its host disconnects.
    queueMicrotask(() => {
      this.pending = false;
      const element = this.element;
      if (!this.isConnected || !element?.isConnected) {
        return;
      }
      this.observer?.observe(element);
      if (this.trackScroll) {
        element.addEventListener("scroll", this.sync);
      } else {
        element.removeEventListener("scroll", this.sync);
      }
      this.sync();
    });
  }

  protected override disconnected(): void {
    this.observer?.disconnect();
    this.element?.removeEventListener("scroll", this.sync);
  }

  protected override reconnected(): void {
    this.schedule();
  }
}

export const scrollState = directive(ScrollStateDirective);
