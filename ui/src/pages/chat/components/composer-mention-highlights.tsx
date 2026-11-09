import { For, Show } from "solid-js";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";

/** Decoration only: the native textarea still owns editing, selection, and accessibility. */
export function ComposerMentionHighlights(props: {
  text: string;
  mentions: readonly HumanMention[];
  scrollTop: number;
}) {
  return (
    <Show when={props.mentions.length > 0}>
      <div class="composer-mention-highlights" aria-hidden="true">
        <div style={{ transform: `translateY(${-props.scrollTop}px)` }}>
          <For each={props.mentions}>
            {(mention, index) => (
              <>
                {props.text.slice(props.mentions[index() - 1]?.end ?? 0, mention.start)}
                <span class="composer-mention-highlight">
                  {props.text.slice(mention.start, mention.end)}
                </span>
              </>
            )}
          </For>
          {props.text.slice(props.mentions.at(-1)?.end ?? 0)}
          {"\n"}
        </div>
      </div>
    </Show>
  );
}
