import { nothing, render, type TemplateResult } from "lit";
import { createEffect, onCleanup } from "solid-js";

/** A temporary island for stateless artwork shared with remaining Lit callers. */
export function LitContent(props: { content: TemplateResult }) {
  let host!: HTMLSpanElement;
  createEffect(
    () => props.content,
    (content) => {
      render(content, host);
    },
  );
  onCleanup(() => render(nothing, host));
  return (
    <span
      ref={(element) => {
        host = element;
      }}
      style={{ display: "contents" }}
    />
  );
}
