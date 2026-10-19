import { createEffect, createMemo, createSignal } from "solid-js";
import { observeScrollState, type ScrollState } from "../../components/scroll-state-observer.ts";

/** Bind the shared scroll observer to a rendered element and its presentation lifetime. */
export function createScrollStateRef(
  onChange: (element: HTMLElement, state: ScrollState) => void,
  options: {
    presented?: () => boolean;
    horizontal?: boolean;
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
    );
    return () => observation.disconnect();
  });
  return (element: HTMLElement) => setElement(element);
}
