import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type {
  ChatMobilePeople,
  ChatMobilePeopleMention,
  ChatMobilePerson,
} from "../chat-mobile-people.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar-view.tsx";
import "../../../styles/chat/mobile-people.css";

type ChatMobilePeopleLabels = {
  people: string;
  viewingNow: string;
  creator: string;
  owner: string;
  participants: string;
  mention: string;
  mentionPerson: (fullName: string) => string;
  morePeople: (count: number) => string;
};

export type ChatMobilePeopleGridProps = {
  people: ChatMobilePeople;
  label: string;
  morePeople: ChatMobilePeopleLabels["morePeople"];
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

export type ChatMobilePeopleBodyProps = {
  people: ChatMobilePeople;
  labels: ChatMobilePeopleLabels;
  /** Parent-owned ChatSessionSharingOptions, including its permission gates. */
  sharingOptions: JSX.Element;
  /** Insert a typed recipient, close People and focus the composer; never send. */
  onMention?: (person: ChatMobilePeopleMention) => void;
};

function PersonName(props: { person: ChatMobilePerson }) {
  return (
    <span class="chat-mobile-people__name" aria-label={props.person.label}>
      {props.person.firstName}
    </span>
  );
}

function PeopleSection(props: {
  title: string;
  people: readonly ChatMobilePerson[];
  labels: ChatMobilePeopleLabels;
  showCount?: boolean;
  onMention?: ChatMobilePeopleBodyProps["onMention"];
}) {
  return (
    <section class="chat-mobile-people__section" aria-label={props.title}>
      <h3>
        {props.title}
        <Show when={props.showCount}>
          <span>{props.people.length}</span>
        </Show>
      </h3>
      <ul class="chat-mobile-people__list">
        <For each={props.people} keyed={(person) => person.key}>
          {(person) => (
            <li class="chat-mobile-people__row">
              <ChatAuthorAvatar sender={person().sender} hideTooltip />
              <PersonName person={person()} />
              <Show when={props.onMention && person().mention}>
                {(mention) => (
                  <button
                    type="button"
                    class="chat-mobile-people__mention"
                    aria-label={props.labels.mentionPerson(person().label)}
                    onClick={() => props.onMention?.(mention())}
                  >
                    <span aria-hidden="true">@</span>
                    <span>{props.labels.mention}</span>
                    <Icon name="chevronRight" />
                  </button>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/** Body only: The mobile host owns route, expansion, scroll, close and focus restoration. */
export function ChatMobilePeopleBody(props: ChatMobilePeopleBodyProps) {
  return (
    <div class="chat-mobile-people" role="group" aria-label={props.labels.people}>
      <Show when={props.people.viewers.length > 0}>
        <section class="chat-mobile-people__section" aria-label={props.labels.viewingNow}>
          <h3>{props.labels.viewingNow}</h3>
          <ul class="chat-mobile-people__viewers">
            <For each={props.people.viewers} keyed={(person) => person.key}>
              {(person) => (
                <li>
                  <Show
                    when={props.onMention && person().mention}
                    fallback={
                      <div class="chat-mobile-people__viewer">
                        <ChatAuthorAvatar sender={person().sender} hideTooltip />
                        <PersonName person={person()} />
                      </div>
                    }
                  >
                    {(mention) => (
                      <button
                        type="button"
                        class="chat-mobile-people__viewer"
                        aria-label={props.labels.mentionPerson(person().label)}
                        onClick={() => props.onMention?.(mention())}
                      >
                        <ChatAuthorAvatar sender={person().sender} hideTooltip />
                        <PersonName person={person()} />
                      </button>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      {props.sharingOptions}
      <Show when={props.people.creator}>
        {(creator) => (
          <PeopleSection
            title={props.labels.creator}
            people={[creator()]}
            labels={props.labels}
            onMention={props.onMention}
          />
        )}
      </Show>
      <Show when={props.people.owner}>
        {(owner) => (
          <PeopleSection
            title={props.labels.owner}
            people={[owner()]}
            labels={props.labels}
            onMention={props.onMention}
          />
        )}
      </Show>
      <Show when={props.people.participants.length > 0}>
        <PeopleSection
          title={props.labels.participants}
          people={props.people.participants}
          labels={props.labels}
          showCount
          onMention={props.onMention}
        />
      </Show>
      <Show when={props.people.unlistedParticipantCount > 0}>
        <p class="chat-mobile-people__unlisted">
          {props.labels.morePeople(props.people.unlistedParticipantCount)}
        </p>
      </Show>
    </div>
  );
}
