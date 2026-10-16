import { onCleanup } from "solid-js";

/** Preserve native event ordering when an enclosing custom element consumes events. */
export function nativeListener<
  EventName extends "click" | "keydown" | "keyup" | "focusout" | "pointerdown",
>(
  type: EventName,
  handle: (event: HTMLElementEventMap[EventName]) => void,
  options?: boolean | AddEventListenerOptions,
) {
  let target: HTMLElement | undefined;
  onCleanup(() => {
    target?.removeEventListener(type, handle, options);
  });
  return (element: HTMLElement) => {
    target = element;
    target.addEventListener(type, handle, options);
  };
}
