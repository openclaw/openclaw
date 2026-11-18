import { createEffect, onCleanup } from "solid-js";

/** Restores the previous title on disposal unless another writer has taken over. */
export function createDocumentTitle(title: () => string) {
  const previousTitle = document.title;
  let activeTitle: string | undefined;
  onCleanup(() => {
    if (activeTitle !== undefined && document.title === activeTitle) {
      document.title = previousTitle;
    }
  });
  createEffect(title, (nextTitle) => {
    document.title = nextTitle;
    activeTitle = nextTitle;
  });
}
