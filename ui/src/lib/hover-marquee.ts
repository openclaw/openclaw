import { createEffect, onCleanup } from "solid-js";
import { cancelLayout, scheduleLayout } from "./layout-frame.ts";
import { listen } from "./reactive/listener.ts";
import { observeIntersection, observeResize } from "./reactive/observers.ts";

const MARQUEE_SPEED_PX_PER_SEC = 40;
const MARQUEE_HOVER_DELAY_MS = 500;
const MARQUEE_LOOP_TRAVEL_FRACTION = 0.4;

type MarqueeEnvironment = {
  motion?: MediaQueryList;
  stopMotion?: () => void;
  notify: () => void;
  targets: Map<Node, Set<MarqueeInvalidation>>;
  observe: (node: Node) => void;
  retireTargets: () => void;
  dispose: () => void;
};
type MarqueeInvalidation = {
  notify: () => void;
  subtree: boolean;
  attributes: readonly string[];
};
const environments = new WeakMap<Document, MarqueeEnvironment>();

function observeEnvironment(
  label: HTMLElement,
  host: HTMLElement,
  schedule: () => void,
  animate: boolean,
) {
  const document = label.ownerDocument;
  let environment = environments.get(document);
  if (!environment) {
    const targets = new Map<Node, Set<MarqueeInvalidation>>();
    const notifyAll = () => {
      for (const entry of targets.get(document.documentElement) ?? []) {
        entry.notify();
      }
    };
    const deliver = (records: MutationRecord[]) => {
      const pending = new Set<() => void>();
      for (const record of records) {
        // A document direction change affects every label. Other mutations
        // invalidate only their registered label/host, not unrelated rows.
        let node: Node | null = record.target;
        while (node) {
          if (node === document.documentElement && record.target !== node) {
            break;
          }
          for (const entry of targets.get(node) ?? []) {
            if (
              (entry.subtree || record.target === node) &&
              (record.type === "attributes"
                ? entry.attributes.includes(record.attributeName!)
                : entry.subtree)
            ) {
              pending.add(entry.notify);
            }
          }
          node = node.parentNode;
        }
      }
      pending.forEach((callback) => callback());
    };
    const observer = new MutationObserver(deliver);
    const observe = (node: Node) => {
      const entries = [...(targets.get(node) ?? [])];
      const subtree = entries.some((entry) => entry.subtree);
      observer.observe(node, {
        childList: subtree,
        characterData: subtree,
        subtree,
        attributes: true,
        attributeFilter: [...new Set(entries.flatMap((entry) => entry.attributes))],
      });
    };
    let retirementQueued = false;
    const stopVisibility = listen(document, "visibilitychange", notifyAll);
    environment = {
      notify: notifyAll,
      targets,
      observe,
      retireTargets() {
        if (retirementQueued) {
          return;
        }
        retirementQueued = true;
        queueMicrotask(() => {
          retirementQueued = false;
          if (!targets.size) {
            return;
          }
          // MutationObserver has no unobserve. Retire removed targets once per
          // commit, preserving queued records for labels that remain mounted.
          deliver(observer.takeRecords());
          observer.disconnect();
          targets.forEach((_entries, node) => observe(node));
        });
      },
      dispose() {
        observer.disconnect();
        this.stopMotion?.();
        stopVisibility();
        environments.delete(document);
      },
    };
    environments.set(document, environment);
  }
  if (animate && !environment.motion) {
    environment.motion = matchMedia("(prefers-reduced-motion: reduce)");
    environment.stopMotion = listen(environment.motion, "change", environment.notify);
  }
  const registrations = [
    { node: label, subtree: true, attributes: ["dir"] },
    { node: host, subtree: false, attributes: ["dir", "aria-expanded"] },
    { node: document.documentElement, subtree: false, attributes: ["dir"] },
  ].map(({ node, subtree, attributes }) => ({
    node,
    entry: { notify: schedule, subtree, attributes },
  }));
  for (const { node, entry } of registrations) {
    let callbacks = environment.targets.get(node);
    if (!callbacks) {
      callbacks = new Set();
      environment.targets.set(node, callbacks);
    }
    callbacks.add(entry);
    // Every label shares the same document-direction observation policy.
    if (node !== document.documentElement || callbacks.size === 1) {
      environment.observe(node);
    }
  }
  return {
    motion: environment.motion,
    dispose: () => {
      for (const { node, entry } of registrations) {
        const callbacks = environment.targets.get(node);
        callbacks?.delete(entry);
        if (callbacks?.size === 0) {
          environment.targets.delete(node);
        }
      }
      if (environment.targets.size === 0) {
        environment.dispose();
      } else {
        environment.retireTargets();
      }
    },
  };
}

export type MarqueeOptions = {
  delay?: number;
  speed?: number;
  loop?: boolean;
  /** Stable interaction host, resolved when this label first becomes visible. */
  host?: () => HTMLElement | undefined;
  /** Measure overflow and retain its end fade, without starting a scroll timer. */
  stationary?: boolean;
  /** Without an interaction host, retain a measured fade without scrolling. */
  stationaryWithoutHost?: boolean;
};

/** Geometry and animation stay in one ref-owned DOM island, outside reactive state. */
export function createHoverMarquee(input: () => MarqueeOptions & { className: string }) {
  const layoutOwner = {};
  let label: HTMLElement;
  let text: HTMLElement;
  let host: HTMLElement | undefined;
  let stationaryHost = false;
  let stopResize: (() => void) | undefined;
  let stopEnvironment: (() => void) | undefined;
  let stopVisibility: (() => void) | undefined;
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
      if (stopEnvironment && label.ownerDocument.visibilityState === "hidden") {
        stop();
        cancelLayout(layoutOwner);
        return;
      }
      scheduleLayout(layoutOwner, measure);
    }
  };
  const stop = () => {
    window.clearTimeout(timer);
    timer = undefined;
    readyToScroll = false;
    label?.classList.toggle("hover-marquee--scrolling", false);
  };
  const active = () =>
    host &&
    (host.matches(":hover, :focus-visible") ||
      (host.contains(label.ownerDocument.activeElement) &&
        label.ownerDocument.activeElement?.matches(":focus-visible")) ||
      // Touch menus keep revealing their trigger while focus moves into the portal.
      (options.loop && host.getAttribute("aria-expanded") === "true"));
  const start = () => {
    if (timer === undefined && !label.classList.contains("hover-marquee--scrolling")) {
      timer = window.setTimeout(() => {
        timer = undefined;
        readyToScroll = true;
        schedule();
      }, options.delay ?? MARQUEE_HOVER_DELAY_MS);
    }
  };
  const enter = () => {
    // Resize/content observers own the resting fade; brief navigation needs no geometry.
    if (
      !options.stationary &&
      !stationaryHost &&
      visible &&
      !motion?.matches &&
      label.classList.contains("hover-marquee--overflowing")
    ) {
      start();
    }
  };
  const leave = (event: Event) => {
    if (
      event instanceof FocusEvent &&
      event.relatedTarget instanceof Node &&
      host?.contains(event.relatedTarget)
    ) {
      return;
    }
    if (!active()) {
      stop();
    }
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
    if ((!host || options.loop) && !stopVisibility) {
      // Defer geometry and resize/content observers until first visibility.
      // Looping names keep this observer to stop when a drawer moves offscreen.
      stopVisibility = observeIntersection([label], (entries) => {
        for (const entry of entries) {
          visible = entry.isIntersecting;
        }
        schedule();
      });
    }
    if (!host && !visible) {
      return undefined;
    }
    if (!host) {
      host = options.host
        ? options.host()
        : (label.closest<HTMLElement>(
            ".session-row-host, .sidebar-recent-sessions__head, .sidebar-identity-card, .sidebar-agent-card__main, .sidebar-workspace-header__main",
          ) ?? undefined);
      if (!host && options.stationaryWithoutHost) {
        host = label;
        stationaryHost = true;
      }
      if (!host) {
        return undefined;
      }
      if (!stationaryHost) {
        for (const event of ["pointerenter", "focusin"]) {
          stopListeners.push(listen(host, event, enter));
        }
        for (const event of ["pointerleave", "focusout"]) {
          stopListeners.push(listen(host, event, leave));
        }
      }
      // Transforms do not resize text, so scrolling cannot invalidate its measurement.
      stopResize = observeResize([label, text], schedule);
      const environment = observeEnvironment(label, host, schedule, !stationaryHost);
      motion = environment.motion;
      stopEnvironment = environment.dispose;
    }
    if (!options.loop && stopVisibility) {
      stopVisibility();
      stopVisibility = undefined;
      visible = true;
    }
    if (label.ownerDocument.visibilityState === "hidden") {
      return stop;
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
    if (options.stationary || stationaryHost || !active() || !visible || motion?.matches) {
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
      } else {
        start();
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
      next.loop !== options.loop ||
      next.stationary !== options.stationary ||
      next.stationaryWithoutHost !== options.stationaryWithoutHost
    ) {
      schedule();
    }
    options = next;
  });
  onCleanup(() => {
    disposed = true;
    cancelLayout(layoutOwner);
    stop();
    stopResize?.();
    stopEnvironment?.();
    stopVisibility?.();
    stopListeners.forEach((release) => release());
  });
  return {
    labelRef: (element: HTMLElement) => (label = element),
    textRef: (element: HTMLElement) => (text = element),
  };
}
