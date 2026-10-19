import { createEffect, onCleanup } from "solid-js";
import { cancelLayout, scheduleLayout } from "./layout-frame.ts";
import { listen } from "./reactive/listener.ts";

const MARQUEE_SPEED_PX_PER_SEC = 40;
const MARQUEE_HOVER_DELAY_MS = 500;
const MARQUEE_LOOP_TRAVEL_FRACTION = 0.4;

export type MarqueeOptions = { delay?: number; speed?: number; loop?: boolean };

/** Geometry and animation stay in one ref-owned DOM island, outside reactive state. */
export function createHoverMarquee(input: () => MarqueeOptions & { className: string }) {
  const layoutOwner = {};
  let label: HTMLElement;
  let text: HTMLElement;
  let host: HTMLElement | undefined;
  let observer: ResizeObserver | undefined;
  let contentObserver: MutationObserver | undefined;
  let visibilityObserver: IntersectionObserver | undefined;
  let visible = false;
  let motion: MediaQueryList | undefined;
  let timer: number | undefined;
  let readyToScroll = false;
  let options: MarqueeOptions & { className?: string } = {};
  let shift = 0;
  let disposed = false;
  const stopListeners: Array<() => void> = [];

  const schedule = () => {
    if (!disposed) {
      scheduleLayout(layoutOwner, measure);
    }
  };
  const stop = () => {
    window.clearTimeout(timer);
    timer = undefined;
    readyToScroll = false;
    label?.classList.remove("hover-marquee--scrolling");
  };
  const clearOverflow = () => {
    label.classList.toggle("hover-marquee--overflowing", false);
    stop();
    label.style.removeProperty("--hover-marquee-shift");
    label.style.removeProperty("--hover-marquee-duration");
    shift = 0;
  };
  const measure = () => {
    if (disposed || !label?.isConnected) {
      return undefined;
    }
    if ((!host || options.loop) && !visibilityObserver) {
      // Defer geometry and resize/content observers until first visibility.
      // Looping names keep this observer to stop when a drawer moves offscreen.
      visibilityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          visible = entry.isIntersecting;
        }
        schedule();
      });
      visibilityObserver.observe(label);
    }
    if (!host && !visible) {
      return undefined;
    }
    if (!host) {
      host =
        label.closest<HTMLElement>(
          ".session-row-host, .sidebar-recent-sessions__head, .sidebar-identity-card, .sidebar-agent-card__main, .sidebar-workspace-header__main",
        ) ?? undefined;
      if (!host) {
        return undefined;
      }
      for (const event of ["pointerenter", "pointerleave", "focusin", "focusout"]) {
        stopListeners.push(listen(host, event, schedule));
      }
      motion = matchMedia("(prefers-reduced-motion: reduce)");
      stopListeners.push(listen(motion, "change", schedule));
      // Transforms do not resize text, so scrolling cannot invalidate its measurement.
      observer = new ResizeObserver(schedule);
      observer.observe(label);
      observer.observe(text);
      contentObserver = new MutationObserver(schedule);
      contentObserver.observe(label, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["dir"],
      });
      contentObserver.observe(host, {
        attributes: true,
        attributeFilter: ["aria-expanded", "dir"],
      });
      contentObserver.observe(label.ownerDocument.documentElement, {
        attributes: true,
        attributeFilter: ["dir"],
      });
    }
    if (!options.loop && visibilityObserver) {
      visibilityObserver.disconnect();
      visibilityObserver = undefined;
      visible = true;
    }
    const width = label.clientWidth;
    if (width <= 0) {
      return clearOverflow;
    }
    const style = getComputedStyle(label);
    const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const overflow = style.whiteSpace === "nowrap" ? text.scrollWidth + padding - width : 0;
    const clipped = overflow > (options.loop ? 0 : 1);
    if (!clipped) {
      return clearOverflow;
    }
    const active =
      host.matches(":hover, :focus-visible") ||
      (host.contains(label.ownerDocument.activeElement) &&
        label.ownerDocument.activeElement?.matches(":focus-visible")) ||
      // Touch menus keep revealing their trigger while focus moves into the portal.
      (options.loop && host.getAttribute("aria-expanded") === "true");
    if (!active || !visible || motion?.matches) {
      return () => {
        label.classList.toggle("hover-marquee--overflowing", clipped);
        stop();
      };
    }
    const fade = Number.parseFloat(style.getPropertyValue("--hover-marquee-fade-width"));
    const nextShift = (overflow + (options.loop ? 0 : fade)) * (style.direction === "rtl" ? 1 : -1);
    const scrolling = label.classList.contains("hover-marquee--scrolling");
    let duration: number | undefined;
    if (nextShift !== shift || !scrolling) {
      const transform = getComputedStyle(text).transform;
      const offset = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
      // Each leg occupies 40% of the loop; the rest pauses at either end.
      const distance = options.loop
        ? Math.abs(nextShift) / MARQUEE_LOOP_TRAVEL_FRACTION
        : Math.abs(nextShift - offset);
      duration = (distance / (options.speed ?? MARQUEE_SPEED_PX_PER_SEC)) * 1000;
    }
    return () => {
      label.classList.toggle("hover-marquee--overflowing", clipped);
      if (duration !== undefined) {
        label.style.setProperty("--hover-marquee-shift", `${nextShift}px`);
        label.style.setProperty("--hover-marquee-duration", `${duration}ms`);
        shift = nextShift;
      }
      if (readyToScroll) {
        readyToScroll = false;
        label.classList.add("hover-marquee--scrolling");
      } else if (timer === undefined && !scrolling) {
        timer = window.setTimeout(() => {
          timer = undefined;
          readyToScroll = true;
          schedule();
        }, options.delay ?? MARQUEE_HOVER_DELAY_MS);
      }
    };
  };

  // Synchronize the measured DOM animation with its reactive options.
  createEffect(input, (next) => {
    if (
      !host ||
      next.className !== options.className ||
      next.delay !== options.delay ||
      next.speed !== options.speed ||
      next.loop !== options.loop
    ) {
      schedule();
    }
    options = next;
  });
  onCleanup(() => {
    disposed = true;
    cancelLayout(layoutOwner);
    stop();
    observer?.disconnect();
    contentObserver?.disconnect();
    visibilityObserver?.disconnect();
    stopListeners.forEach((release) => release());
  });
  return {
    labelRef: (element: HTMLElement) => (label = element),
    textRef: (element: HTMLElement) => (text = element),
  };
}
