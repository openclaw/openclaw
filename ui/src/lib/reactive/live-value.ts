import { createEffect, untrack } from "@solidjs/signals";

/** Keep native text selection when an owner republishes the displayed value. */
export function liveValue(value: () => string) {
  let field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined;
  createEffect(value, (next) => {
    if (field && field.value !== next) {
      field.value = next;
    }
  });
  return (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    field = element;
    const next = untrack(value);
    if (element.value !== next) {
      element.value = next;
    }
  };
}
