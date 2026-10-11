import { createRenderEffect, onCleanup, Show, untrack } from "solid-js";
import { hasComposerContent, renderComposerContent } from "./chat-composer-controls.ts";

/** Opaque content keeps its Lit owner until that caller is ported. */
export function LitContent(props: { value: unknown }) {
  let element: HTMLSpanElement | undefined;
  createRenderEffect(
    () => props.value,
    (value) => {
      if (element) {
        renderComposerContent(value, element);
      }
    },
  );
  onCleanup(() => {
    if (element) {
      renderComposerContent(undefined, element);
    }
  });
  return (
    <Show when={hasComposerContent(props.value)}>
      <span
        class="chat-composer-lit-content"
        style={{ display: "contents" }}
        ref={(node) => {
          element = node;
          // The unowned ref lets nested Solid adapters mount outside component evaluation.
          renderComposerContent(
            untrack(() => props.value),
            node,
          );
        }}
      />
    </Show>
  );
}
