import { onCleanup } from "solid-js";
import { listen } from "./reactive/listener.ts";

/** Preserve native event ordering when an enclosing custom element consumes events. */
export function nativeListener<EventName extends keyof HTMLElementEventMap>(
  type: EventName,
  handle: (event: HTMLElementEventMap[EventName]) => void,
  options?: boolean | AddEventListenerOptions,
) {
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());
  return (element: HTMLElement) => {
    stop?.();
    stop = listen(element, type, handle, options);
  };
}
