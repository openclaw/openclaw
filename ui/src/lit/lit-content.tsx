import { dynamic, type JSX } from "@solidjs/web";
import { nothing, render } from "lit";
import { createEffect, onCleanup } from "solid-js";

/** Temporary island for stateless Lit helpers whose callers migrate separately. */
export function LitContent(props: {
  children: unknown;
  tag?: "div" | "span" | "article";
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  style?: JSX.HTMLAttributes<HTMLElement>["style"];
  onClick?: JSX.EventHandler<HTMLElement, MouseEvent>;
}) {
  let container!: HTMLElement;
  // eslint-disable-next-line solid/reactivity -- Solid 2 dynamic owns this tracked source.
  const Container = dynamic(() => props.tag ?? "div");
  createEffect(
    () => props.children,
    (content) => {
      render(content, container);
    },
  );
  onCleanup(() => {
    const part = render(nothing, container);
    part.setConnected(false);
  });
  return (
    <Container
      class={["lit-content", props.class]}
      style={props.style ?? (props.tag ? undefined : { display: "contents" })}
      onClick={props.onClick}
      ref={(element: HTMLElement) => {
        container = element;
      }}
    />
  );
}
