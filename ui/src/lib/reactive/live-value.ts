import { createEffect } from "@solidjs/signals";

/** Snapshot the initial native value; later owner updates preserve text selection. */
export function liveValue(value: () => string) {
  let field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined;
  createEffect(value, (next) => {
    if (field && field.value !== next) {
      field.value = next;
    }
  });
  return (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    field = element;
    const next = value();
    if (element.value !== next) {
      element.value = next;
    }
  };
}
