import type { JSX } from "@solidjs/web";
import { nothing, render } from "lit";
import { createRenderEffect, onCleanup } from "solid-js";

/** A temporary, isolated outlet for helpers whose owning surface still renders Lit. */
export function LitContent(props: { content: unknown; class?: string }): JSX.Element {
  const outlet = document.createElement("span");
  outlet.style.display = "contents";
  createRenderEffect(
    () => ({ content: props.content, className: props.class }),
    ({ content, className }) => {
      outlet.className = className ?? "";
      render(content, outlet);
    },
  );
  onCleanup(() => render(nothing, outlet));
  return outlet;
}
