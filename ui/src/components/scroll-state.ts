import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { observeScrollState, type ScrollState } from "./scroll-state-observer.ts";

/** Reveal an option without scrollIntoView also moving its popup's ancestors. */
export function revealInScrollRegion(region: HTMLElement, option: HTMLElement): void {
  const bounds = region.getBoundingClientRect();
  const row = option.getBoundingClientRect();
  if (row.top < bounds.top) {
    region.scrollTop -= bounds.top - row.top;
  } else if (row.bottom > bounds.bottom) {
    region.scrollTop += row.bottom - bounds.bottom;
  }
}

class ScrollStateDirective extends AsyncDirective {
  private element: HTMLElement | undefined;
  private horizontal = false;
  private trackScroll = true;
  private observation: ReturnType<typeof observeScrollState> | undefined;
  private readonly publish = (state: ScrollState) => {
    const element = this.element;
    if (!element) {
      return;
    }
    for (const key of ["scrollable", "atStart", "atEnd"] as const) {
      const value = String(state[key]);
      if (element.dataset[key] !== value) {
        element.dataset[key] = value;
      }
    }
  };

  render(_horizontal = false, _trackScroll = true) {
    return nothing;
  }

  override update(
    part: ElementPart,
    [horizontal = false, trackScroll = true]: [boolean?, boolean?],
  ) {
    const element = part.element instanceof HTMLElement ? part.element : undefined;
    if (
      element !== this.element ||
      horizontal !== this.horizontal ||
      trackScroll !== this.trackScroll
    ) {
      this.observation?.disconnect();
      this.observation = undefined;
      this.element = element;
      this.horizontal = horizontal;
      this.trackScroll = trackScroll;
    }
    this.connect();
    this.observation?.schedule();
    return nothing;
  }

  private connect(): void {
    if (this.isConnected && this.element && !this.observation) {
      this.observation = observeScrollState(
        this.element,
        this.publish,
        this.horizontal,
        this.trackScroll,
      );
    }
  }

  protected override disconnected(): void {
    this.observation?.disconnect();
    this.observation = undefined;
  }

  protected override reconnected(): void {
    this.connect();
  }
}

export const scrollState = directive(ScrollStateDirective);
