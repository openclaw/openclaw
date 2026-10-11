import { nothing, render } from "lit";
import { createRenderEffect, onCleanup } from "solid-js";

/** Unported content keeps its own DOM and cleanup until its owning lane migrates it. */
export function PaletteLitContent(props: { content: unknown }) {
  const host = document.createElement("span");
  host.style.display = "contents";
  createRenderEffect(
    () => props.content,
    (content) => {
      render(content, host);
    },
  );
  onCleanup(() => render(nothing, host));
  return host;
}
