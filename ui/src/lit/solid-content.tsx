import { nothing, render } from "lit";
import { createEffect, onCleanup, untrack } from "solid-js";

/** Retained stateless Lit helpers own only this child region during the renderer migration. */
export function LitContent(props: { value: unknown }) {
  let target!: HTMLSpanElement;
  createEffect(
    () => props.value,
    (value) => {
      untrack(() => render(value, target));
    },
  );
  onCleanup(() => render(nothing, target));
  return (
    <span
      ref={(node) => {
        target = node;
      }}
      style={{ display: "contents" }}
    />
  );
}
