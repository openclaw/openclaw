import { createEffect, createMemo, createSignal } from "solid-js";
import { observeScrollState, type ScrollState } from "../../components/scroll-state-observer.ts";
import { revealInScrollRegion } from "../../components/scroll-state.ts";
import { cancelLayout, scheduleLayout } from "../layout-frame.ts";
import { listen } from "./listener.ts";

/** Bind the shared scroll observer to a rendered element and its presentation lifetime. */
export function createScrollStateRef(
  onChange: (element: HTMLElement, state: ScrollState) => void,
  options: {
    presented?: () => boolean;
    horizontal?: boolean;
    trackScroll?: boolean;
    content?: () => unknown;
  } = {},
) {
  const [currentElement, setElement] = createSignal<HTMLElement>();
  const target = createMemo(
    () => ({
      element: currentElement(),
      presented: options.presented?.() ?? true,
      content: options.content?.(),
    }),
    {
      equals: (before, after) =>
        before.element === after.element &&
        before.presented === after.presented &&
        before.content === after.content,
    },
  );
  createEffect(target, ({ element, presented }) => {
    if (!element || !presented) {
      return undefined;
    }
    const observation = observeScrollState(
      element,
      (state) => onChange(element, state),
      options.horizontal,
      options.trackScroll,
    );
    return () => observation.disconnect();
  });
  return (element: HTMLElement) => setElement(element);
}

type ScrollTarget = {
  identity: readonly unknown[];
  target: () => HTMLElement | null | undefined;
};

function scrollIdentityChanged(
  next: Pick<ScrollTarget, "identity">,
  previous: Pick<ScrollTarget, "identity"> | undefined,
) {
  return (
    !previous ||
    next.identity.length !== previous.identity.length ||
    next.identity.some((value, index) => value !== previous.identity[index])
  );
}

type RetainedScrollPosition = {
  identity: readonly unknown[];
  target: HTMLElement | null | undefined;
  presented: boolean;
  ready: boolean;
};
/** Apply identity-driven scroll commands; resolve targets after DOM commit or in the requested frame. */
export function createScrollPosition(
  read: () =>
    | {
        retain: RetainedScrollPosition | undefined;
        reset?: never;
        reveal?: never;
        restore?: never;
      }
    | {
        retain?: never;
        reset?: ScrollTarget;
        reveal?: ScrollTarget;
        restore?: {
          identity: readonly unknown[];
          target: HTMLElement | null | undefined;
          top?: number;
          left?: number | "end";
        };
      },
  options: {
    region?: () => HTMLElement;
    revealTiming?: "animation-frame";
  } = {},
) {
  let retained:
    | { identity: readonly unknown[]; target: HTMLElement; top: number; pending: boolean }
    | undefined;
  const retainedLayout = {};
  createEffect(read, (next, previous) => {
    if ("retain" in next) {
      const input = next.retain;
      const target = input?.target;
      if (!input || !target) {
        retained = undefined;
        return undefined;
      }
      if (!retained || retained.target !== target || scrollIdentityChanged(input, retained)) {
        retained = { identity: input.identity, target, top: 0, pending: true };
      }
      const position = retained;
      let active = true;
      if (!input.presented) {
        position.pending = true;
      }
      const remember = () => {
        if (input.presented && !position.pending) {
          position.top = target.scrollTop;
        }
      };
      const interrupt = (event: Event) => {
        if (
          event instanceof KeyboardEvent &&
          !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Tab"].includes(
            event.key,
          )
        ) {
          return;
        }
        if (input.presented) {
          position.pending = false;
          position.top = target.scrollTop;
        }
      };
      const stops = [
        listen(target, "scroll", remember, { passive: true }),
        listen(target, "wheel", interrupt, { passive: true }),
        listen(target, "pointerdown", interrupt, { passive: true }),
        listen(target, "keydown", interrupt),
      ];
      if (input.presented && input.ready && position.pending) {
        scheduleLayout(retainedLayout, () => {
          if (retained !== position || !target.isConnected || !position.pending) {
            return undefined;
          }
          const top = Math.min(
            position.top,
            Math.max(0, target.scrollHeight - target.clientHeight),
          );
          return () => {
            // Cancellation may happen during another owner's read in this frame.
            if (!active || retained !== position || !position.pending) {
              return;
            }
            target.scrollTop = top;
            position.top = top;
            position.pending = false;
          };
        });
      }
      return () => {
        active = false;
        cancelLayout(retainedLayout);
        stops.forEach((stop) => stop());
      };
    }
    retained = undefined;
    if (next.restore && scrollIdentityChanged(next.restore, previous?.restore)) {
      const target = next.restore.target;
      if (target) {
        if (next.restore.top !== undefined) {
          target.scrollTop = next.restore.top;
        }
        if (next.restore.left !== undefined) {
          target.scrollLeft = next.restore.left === "end" ? target.scrollWidth : next.restore.left;
        }
      }
    }
    if (next.reset && scrollIdentityChanged(next.reset, previous?.reset)) {
      const target = next.reset.target();
      if (target) {
        target.scrollTop = 0;
        target.scrollLeft = 0;
      }
    }
    const request = next.reveal;
    if (!request || !scrollIdentityChanged(request, previous?.reveal)) {
      return undefined;
    }
    const reveal = () => {
      const target = request.target();
      if (!target) {
        return;
      }
      if (options.region) {
        const region = options.region();
        if (region.contains(target)) {
          revealInScrollRegion(region, target);
        }
      } else {
        target.scrollIntoView?.({ block: "nearest" });
      }
    };
    if (options.revealTiming === "animation-frame") {
      const frame = requestAnimationFrame(reveal);
      return () => cancelAnimationFrame(frame);
    }
    reveal();
    return undefined;
  });
}
