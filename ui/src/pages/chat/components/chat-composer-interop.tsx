import { Show } from "solid-js";
import { emptyLegacyContent, LitContent as LegacyContent } from "../../../lit/solid-content.tsx";

export function hasComposerContent(value: unknown): boolean {
  return value != null && value !== false && value !== "" && value !== emptyLegacyContent;
}

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
