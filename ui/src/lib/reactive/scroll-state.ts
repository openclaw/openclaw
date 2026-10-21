import { createEffect, createMemo, createSignal } from "solid-js";
import { observeScrollState, type ScrollState } from "../../components/scroll-state-observer.ts";
import { revealInScrollRegion } from "../../components/scroll-state.ts";

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

function scrollIdentityChanged(next: ScrollTarget, previous: ScrollTarget | undefined) {
  return (
    !previous ||
    next.identity.length !== previous.identity.length ||
    next.identity.some((value, index) => value !== previous.identity[index])
  );
}

/** Apply identity-driven scroll commands; resolve targets after DOM commit or in the requested frame. */
export function createScrollPosition(
  read: () => { reset?: ScrollTarget; reveal?: ScrollTarget },
  options: {
    region?: () => HTMLElement;
    revealTiming?: "animation-frame";
  } = {},
) {
  createEffect(read, (next, previous) => {
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
