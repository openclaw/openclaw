import { createRenderEffect, untrack } from "solid-js";

/** Keep a controlled value current without rewriting selection or the native undo buffer. */
export function liveValue(value: () => string) {
  let element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
  createRenderEffect(value, (next) => {
    if (element && element.value !== next) {
      element.value = next;
    }
  });
  return (target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
    element = target;
    const next = untrack(value);
    if (target.value !== next) {
      target.value = next;
    }
  };
}
