import { createEffect, createMemo } from "@solidjs/signals";

/** Keep unrelated attribute updates from overwriting native checkbox activation. */
export function liveChecked(value: () => boolean) {
  const checked = createMemo(value);
  let field: HTMLInputElement | undefined;
  let committed: boolean | undefined;
  const write = (next: boolean) => {
    if (field && field.checked !== next) {
      field.checked = next;
    }
  };
  createEffect(checked, (next) => {
    committed = next;
    write(next);
  });
  return (element: HTMLInputElement) => {
    field = element;
    if (committed !== undefined) {
      write(committed);
    }
  };
}
