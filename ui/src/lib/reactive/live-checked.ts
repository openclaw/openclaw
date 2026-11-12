import { createRenderEffect } from "@solidjs/signals";

/** Keep unrelated attribute updates from overwriting native checkbox activation. */
export function liveChecked(value: () => boolean) {
  let field: HTMLInputElement | undefined;
  let committed: boolean | undefined;
  const write = (next: boolean) => {
    if (field && field.checked !== next) {
      field.checked = next;
    }
  };
  // Equal-valued owner refreshes still need to restore changed native state.
  createRenderEffect(value, (next) => {
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
