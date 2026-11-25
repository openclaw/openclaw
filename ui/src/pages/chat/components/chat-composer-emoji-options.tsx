import { For } from "solid-js";
import { paneDomId } from "./chat-composer-dom.ts";
import type { ComposerEmojiMenu } from "./chat-composer-emoji-state.ts";
import { renderComposerMenuOption as ComposerMenuOption } from "./chat-composer-menu.tsx";

export function EmojiMenuOptions(props: {
  menu: ComposerEmojiMenu;
  paneId: string;
  textarea: HTMLTextAreaElement;
}) {
  return (
    <For each={props.menu.state.items} keyed={(name) => name}>
      {(name, index) => (
        <ComposerMenuOption
          id={paneDomId(props.paneId, `emoji-option-${index()}`)}
          active={index() === props.menu.state.index}
          select={() => props.menu.select(props.textarea, index())}
          hover={() => props.menu.hover(index())}
          icon={props.menu.emojiForShortcode(name())}
          iconHidden={true}
          name={`:${name()}:`}
          description={undefined}
        />
      )}
    </For>
  );
}
