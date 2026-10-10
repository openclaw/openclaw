import { nothing, render } from "lit";
import { createEffect, onCleanup } from "solid-js";

/** Keep the remaining stateless Lit helpers inside their own DOM owner. */
export function LitContent(props: { content: () => unknown }) {
  let host!: HTMLSpanElement;
  createEffect(
    () => props.content(),
    (content) => {
      render(content, host, { host });
    },
  );
  onCleanup(() => {
    render(nothing, host).setConnected(false);
  });
  return (
    <span
      ref={(element) => {
        host = element;
      }}
      style={{ display: "contents" }}
    />
  );
}
