import { createMemo, For, Show } from "solid-js";
import type {
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../../../../packages/gateway-protocol/src/schema/session-participant.js";
import {
  personActivityLink,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { ParticipantAvatar } from "../../../components/solid/viewer-facepile.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { sessionParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "./chat-details-people.css";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";

registerEnglishCatalog(registerChatSessionEnglish);

type ChatDetailsPeopleFacts = {
  /** Session people in the parent's order, including its projected owner/creator. */
  people: readonly SessionParticipant[];
  /** Distinct total for this union, if known; not the raw participantCount. */
  totalCount?: number;
};

export type ChatDetailsPeopleProps = ChatDetailsPeopleFacts & {
  ownerIdentity?: SessionParticipantIdentity;
  personActivity?: PersonActivityRouting;
};

export type ChatDetailsPeopleSummaryProps = ChatDetailsPeopleFacts & {
  expanded: boolean;
};

function uniquePeople(people: readonly SessionParticipant[]): SessionParticipant[] {
  const identities = new Set<string>();
  return people.filter(({ identity }) => {
    const key = sessionParticipantIdentityKey(identity);
    if (identities.has(key)) {
      return false;
    }
    identities.add(key);
    return true;
  });
}

function PeopleAvatar(props: { person: SessionParticipant }) {
  return (
    <ParticipantAvatar
      user={{
        id: props.person.identity.id,
        identity: props.person.identity,
        name: props.person.label || props.person.identity.id,
        avatarUrl: props.person.avatarUrl,
        watchedSessions: [],
      }}
      markAsViewer={false}
    />
  );
}

/** Metadata slot only. Details owns the heading, disclosure and in-memory choice. */
export function ChatDetailsPeopleSummary(props: ChatDetailsPeopleSummaryProps) {
  const people = createMemo(() => uniquePeople(props.people));
  const total = () => Math.max(people().length, props.totalCount ?? 0);
  const preview = () => people().slice(0, 3);
  const remaining = () => total() - preview().length;
  return (
    <span class="chat-details-people__summary">
      <span class="sr-only">
        {t("chat.sessionDetails.participants", { count: String(total()) })}
      </span>
      <Show
        when={props.expanded}
        fallback={
          <span class="chat-details-people__preview" aria-hidden="true">
            <For
              each={preview()}
              keyed={(person) => sessionParticipantIdentityKey(person.identity)}
            >
              {(person) => (
                <span
                  class="chat-details-people__preview-avatar"
                  title={person().label || person().identity.id}
                >
                  <PeopleAvatar person={person()} />
                </span>
              )}
            </For>
            <Show when={remaining() > 0}>
              <span class="chat-details-people__overflow">+{remaining()}</span>
            </Show>
          </span>
        }
      >
        <span
          class="chat-details-people__count chat-details-desktop-section__count"
          aria-hidden="true"
        >
          <span class="chat-details-desktop-section__count-separator">·</span>
          {total()}
        </span>
      </Show>
    </span>
  );
}

/** Desktop list body. No roster loading, permission inference or disclosure state. */
export function ChatDetailsPeople(props: ChatDetailsPeopleProps) {
  const people = createMemo(() => uniquePeople(props.people));
  const ownerKey = () => props.ownerIdentity && sessionParticipantIdentityKey(props.ownerIdentity);
  const remaining = () => Math.max(0, (props.totalCount ?? people().length) - people().length);
  return (
    <ul class="chat-details-people">
      <For each={people()} keyed={(person) => sessionParticipantIdentityKey(person.identity)}>
        {(person) => {
          const name = () => person().label || person().identity.id;
          const isOwner = () => sessionParticipantIdentityKey(person().identity) === ownerKey();
          const target = () =>
            person().identity.type === "profile"
              ? personActivityLink(person().identity.id, props.personActivity, name())
              : null;
          const content = () => (
            <>
              <span class="chat-details-people__avatar" aria-hidden="true">
                <PeopleAvatar person={person()} />
              </span>
              <PeopleName name={name()} />
              <Show when={isOwner()}>
                {" "}
                <span class="chat-details-people__role">{t("chat.sessionDetails.owner")}</span>
              </Show>
            </>
          );
          return (
            <li class="chat-details-people__person">
              <Show
                when={target()}
                fallback={<span class="chat-details-people__row">{content()}</span>}
              >
                {(link) => (
                  <a
                    class="chat-details-people__row"
                    aria-label={isOwner() ? `${name()} ${t("chat.sessionDetails.owner")}` : name()}
                    href={link().href}
                    onClick={(event) => link().open(event)}
                  >
                    {content()}
                  </a>
                )}
              </Show>
            </li>
          );
        }}
      </For>
      <Show when={remaining() > 0}>
        <li class="chat-details-people__remaining">
          {t("chat.sessionDetails.moreParticipants", { count: String(remaining()) })}
        </li>
      </Show>
    </ul>
  );
}

function PeopleName(props: { name: string }) {
  let viewport!: HTMLSpanElement;
  let text!: HTMLSpanElement;
  const measure = () => {
    const overflowing = viewport.clientWidth > 0 && text.scrollWidth > viewport.clientWidth;
    return () => {
      viewport.toggleAttribute("data-overflow", overflowing);
      // Only clipped names need a tooltip; the full name remains accessible in the row.
      if (overflowing) {
        viewport.title = text.textContent ?? "";
      } else {
        viewport.removeAttribute("title");
      }
    };
  };
  createLayoutMeasurement(() => props.name, measure, { targets: () => [viewport, text] });
  return (
    <span ref={(element) => (viewport = element)} class="chat-details-people__name">
      <span ref={(element) => (text = element)}>{props.name}</span>
    </span>
  );
}
