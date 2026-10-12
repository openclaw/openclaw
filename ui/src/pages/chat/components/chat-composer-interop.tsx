import { createRenderEffect, getOwner, onCleanup, runWithOwner, Show, untrack } from "solid-js";
import { hasComposerContent, renderComposerContent } from "./chat-composer-controls.ts";

/** Opaque content keeps its Lit owner until that caller is ported. */
export function LitContent(props: { value: unknown }) {
  let element: HTMLSpanElement | undefined;
  // Effect callbacks run without an ambient owner; restoring this one makes
  // nested Solid directives defer their roots instead of halting reactivity.
  const owner = getOwner();
  createRenderEffect(
    () => props.value,
    (value) => {
      if (element) {
        const node = element;
        runWithOwner(owner, () => renderComposerContent(value, node));
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
