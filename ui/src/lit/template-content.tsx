import { nothing, render } from "lit";
import { createEffect, onCleanup } from "solid-js";

/** Unported stateless templates exclusively own this adapter's descendants. */
export function LitContent(props: { render: () => unknown }) {
  let host!: HTMLSpanElement;
  let part: ReturnType<typeof render> | undefined;
  createEffect(
    () => props.render(),
    (template) => {
      part = render(template, host, { host });
    },
  );
  onCleanup(() => {
    part?.setConnected(false);
    render(nothing, host);
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
