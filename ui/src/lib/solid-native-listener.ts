import { elementRef } from "./reactive/element-ref.ts";
import { listen } from "./reactive/listener.ts";

/** Preserve native event ordering when an enclosing custom element consumes events. */
export function nativeListener<EventName extends keyof HTMLElementEventMap>(
  type: EventName,
  handle: (event: HTMLElementEventMap[EventName]) => void,
  options?: boolean | AddEventListenerOptions,
) {
  return elementRef((element: HTMLElement) => listen(element, type, handle, options));
}
