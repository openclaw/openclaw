import { createEffect } from "@solidjs/signals";

/** Snapshot the initial native value; later owner updates preserve text selection. */
export function liveValue<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  value: () => string,
  onValueChange?: (field: T) => void,
) {
  let field: T | undefined;
  const writeValue = (next: string) => {
    if (field && field.value !== next) {
      field.value = next;
      onValueChange?.(field);
    }
  };
  createEffect(value, writeValue);
  return (element: T) => {
    field = element;
    writeValue(value());
  };
}
