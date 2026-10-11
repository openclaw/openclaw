import { render, nothing } from "lit";
import { createEffect, onCleanup, untrack } from "solid-js";
export type * from "../types/solid-elements.d.ts";

/** A temporary leaf boundary for shared template helpers whose owners still use Lit. */
export function LitContent(props: {
  value: unknown;
  tag?: "span" | "div" | "code";
  class?: string;
}) {
  let host!: HTMLElement;
  // The native host stays fixed for this leaf's lifetime, like any JSX element.
  const tag = untrack(() => props.tag);
  const assignHost = (element: HTMLElement) => {
    host = element;
  };
  createEffect(
    () => props.value,
    (value) => {
      render(value, host, { host });
    },
  );
  onCleanup(() => render(nothing, host));
  return (
    <>
      {tag === "div" ? (
        <div ref={assignHost} class={props.class} />
      ) : tag === "code" ? (
        <code ref={assignHost} class={props.class} />
      ) : (
        <span ref={assignHost} class={props.class} style={{ display: "contents" }} />
      )}
    </>
  );
}
