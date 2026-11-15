import { createEffect } from "@solidjs/signals";

/** Apply committed values to native fields while preserving unchanged text selection. */
export function liveValue<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  value: () => string,
  onValueChange?: (field: T) => void,
) {
  let field: T | undefined;
  let committedValue: string | undefined;
  const writeValue = (next: string) => {
    if (field && field.value !== next) {
      field.value = next;
      onValueChange?.(field);
    }
  };
  createEffect(value, (next) => {
    committedValue = next;
    writeValue(next);
  });
  return (element: T) => {
    field = element;
    if (committedValue !== undefined) {
      writeValue(committedValue);
    }
  };
}
