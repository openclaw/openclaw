import { createEffect, createMemo, useContext } from "solid-js";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import { observeScrollState } from "../scroll-state-observer.ts";
import { revealInScrollRegion } from "../scroll-state.ts";

export function useScrollState(
  horizontal = false,
  trackScroll = true,
  options?: { revision?: () => unknown; activeId?: () => string | null | undefined },
) {
  const presented = useContext(ContentPresentation);
  const isPresented = createMemo(presented);
  let element: HTMLElement;
  createEffect(
    () => [isPresented(), options?.revision?.()] as const,
    ([active]) => {
      if (!active) {
        return undefined;
      }
      const observation = observeScrollState(
        element,
        (state) => {
          for (const key of ["scrollable", "atStart", "atEnd"] as const) {
            const value = String(state[key]);
            if (element.dataset[key] !== value) {
              element.dataset[key] = value;
            }
          }
        },
        horizontal,
        trackScroll,
      );
      return () => observation.disconnect();
    },
  );
  if (options?.activeId) {
    createEffect(options.activeId, (activeId) => {
      if (!activeId) {
        return undefined;
      }
      const frame = requestAnimationFrame(() => {
        const active = element.ownerDocument.getElementById(activeId);
        if (active && element.contains(active)) {
          revealInScrollRegion(element, active);
        }
      });
      return () => cancelAnimationFrame(frame);
    });
  }
  return (value: HTMLElement) => {
    element = value;
  };
}
