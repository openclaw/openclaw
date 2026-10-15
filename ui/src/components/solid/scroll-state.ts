import { createEffect, createMemo, useContext } from "solid-js";
import { SolidContentPresentation } from "../../lit/solid-content.tsx";
import { observeScrollState } from "../scroll-state-observer.ts";

export function useScrollState(horizontal = false, trackScroll = true) {
  const presented = useContext(SolidContentPresentation);
  let element: HTMLElement;
  createEffect(createMemo(presented), (active) => {
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
  });
  return (value: HTMLElement) => {
    element = value;
  };
}
