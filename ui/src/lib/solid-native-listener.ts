import { onCleanup } from "solid-js";

/** Preserve native bubbling order when an enclosing custom element consumes events. */
export function nativeListener<EventName extends "click" | "keydown">(
  type: EventName,
  handle: (event: HTMLElementEventMap[EventName]) => void,
) {
  let target: HTMLElement | undefined;
  onCleanup(() => {
    target?.removeEventListener(type, handle);
  });
  return (element: HTMLElement) => {
    target = element;
    target.addEventListener(type, handle);
  };
}
