import { nothing, render } from "lit";
import { createRenderEffect, onCleanup } from "solid-js";

/** Isolates retained Lit template helpers until their rendering owners migrate. */
export function LitContent(props: { value: unknown }) {
  const container = document.createElement("span");
  container.style.display = "contents";
  createRenderEffect(
    () => props.value,
    (value) => {
      render(value, container);
    },
  );
  onCleanup(() => render(nothing, container));
  return container;
}
