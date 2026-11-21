import { onSettled } from "solid-js";
import { registerRouteElement } from "./route-elements.ts";

/** Capture from an unowned ref; register and release with the component lifetime. */
export function createRouteElementRef(key: string): (element: HTMLElement) => void {
  let element: HTMLElement | undefined;
  onSettled(() => element && registerRouteElement(element, key));
  return (next) => {
    element = next;
  };
}
