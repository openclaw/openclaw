import { Show } from "solid-js";
import { LitContent as LegacyContent } from "../../../lit/solid-content.tsx";
import { hasComposerContent } from "./chat-composer-controls.ts";

/** Opaque content keeps its Lit owner until that caller is ported. */
export function LitContent(props: { value: unknown }) {
  return (
    <Show when={hasComposerContent(props.value)}>
      <span class="chat-composer-lit-content" style={{ display: "contents" }}>
        <LegacyContent value={props.value} />
      </span>
    </Show>
  );
}
