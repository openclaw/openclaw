import { useContext } from "solid-js";
import { createScrollPosition, createScrollStateRef } from "../../lib/reactive/scroll-state.ts";
import { ContentPresentation } from "../../lib/solid/presentation.ts";

export function useScrollState(
  horizontal = false,
  trackScroll = true,
  options?: { revision?: () => unknown; activeId?: () => string | null | undefined },
) {
  const presented = useContext(ContentPresentation);
  const scrollRef = createScrollStateRef(
    (element, state) => {
      for (const key of ["scrollable", "atStart", "atEnd"] as const) {
        const value = String(state[key]);
        if (element.dataset[key] !== value) {
          element.dataset[key] = value;
        }
      }
    },
    { presented, horizontal, trackScroll, content: options?.revision },
  );
  let element: HTMLElement;
  const activeId = options?.activeId;
  if (activeId) {
    createScrollPosition(
      () => {
        const id = activeId();
        return {
          reveal: id
            ? { identity: [id], target: () => element.ownerDocument.getElementById(id) }
            : undefined,
        };
      },
      { region: () => element, revealTiming: "animation-frame" },
    );
  }
  return (value: HTMLElement) => {
    element = value;
    scrollRef(value);
  };
}
