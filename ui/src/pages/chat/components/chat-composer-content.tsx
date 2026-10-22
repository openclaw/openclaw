import type { JSX } from "@solidjs/web";
import { children, Show } from "solid-js";

export function ComposerContent(props: { children: JSX.Element }) {
  const content = children(() => props.children);
  return (
    <Show when={content() != null && content() !== false && content() !== ""}>
      <span class="chat-composer-lit-content" style={{ display: "contents" }}>
        {content()}
      </span>
    </Show>
  );
}
