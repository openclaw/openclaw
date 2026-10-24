import { For, Show } from "solid-js";
import type { ChatMobilePeople } from "../chat-mobile-people.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar-view.tsx";
import type { ChatMobilePeopleBodyProps } from "./chat-mobile-people.tsx";
import "../../../styles/chat/mobile-people.css";

export type ChatMobilePeopleGridProps = {
  people: ChatMobilePeople;
  label: string;
  morePeople: ChatMobilePeopleBodyProps["labels"]["morePeople"];
  expanded: boolean;
  controls: string;
  onOpen: (source: HTMLButtonElement) => void;
  ref?: (element: HTMLButtonElement) => void;
};

/** The mobile header supplies this slot outside its action capsule. */
export function ChatMobilePeopleGrid(props: ChatMobilePeopleGridProps) {
  const count = () => props.people.header.length;
  const visible = () => props.people.header.slice(0, count() > 4 ? 3 : 4);
  return (
    <Show when={count() > 0}>
      <button
        ref={props.ref}
        type="button"
        class="chat-mobile-people-grid"
        aria-label={props.label}
        aria-haspopup="dialog"
        aria-expanded={props.expanded ? "true" : "false"}
        aria-controls={props.controls}
        onClick={(event) => props.onOpen(event.currentTarget)}
      >
        <span class="chat-mobile-people-grid__canvas" data-count={Math.min(count(), 4)}>
          <For each={visible()}>
            {(person) => (
              <span
                class={[
                  "chat-mobile-people-grid__avatar",
                  { "chat-mobile-people-grid__avatar--away": !person.viewing },
                ]}
              >
                <ChatAuthorAvatar sender={person.sender} hideTooltip />
              </span>
            )}
          </For>
          <Show when={count() > 4}>
            <span class="chat-mobile-people-grid__more" aria-label={props.morePeople(count() - 3)}>
              +{count() - 3}
            </span>
          </Show>
        </span>
      </button>
    </Show>
  );
}
