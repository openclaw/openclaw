import { createMemo, For, Show } from "solid-js";
import type {
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { PersonActivityRouting } from "../../../components/person-activity-link.ts";
import { ParticipantAvatar } from "../../../components/solid/viewer-facepile.tsx";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { sessionParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "./chat-details-people.css";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

type ChatDetailsPeopleFacts = {
  /** Session people in the parent's order, including its projected owner/creator. */
  people: readonly SessionParticipant[];
  /** The loaded identities are not a confirmed complete participant list. */
  partial?: boolean;
};

export type ChatDetailsPeopleProps = ChatDetailsPeopleFacts & {
  ownerIdentity?: SessionParticipantIdentity;
  personActivity?: PersonActivityRouting;
};

export type ChatDetailsPeopleSummaryProps = ChatDetailsPeopleFacts & {
  expanded: boolean;
};

export function uniquePeople(people: readonly SessionParticipant[]): SessionParticipant[] {
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

export function PeopleAvatar(props: { person: SessionParticipant }) {
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
  const preview = () => people().slice(0, 3);
  const remaining = () => people().length - preview().length;
  return (
    <span class="chat-details-people__summary">
      <Show when={!props.partial}>
        <span class="sr-only">
          {t("chat.sessionDetails.peopleCount", { count: String(people().length) })}
        </span>
      </Show>
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
        <Show when={!props.partial}>
          <span
            class="chat-details-people__count chat-details-desktop-section__count"
            aria-hidden="true"
          >
            <span class="chat-details-desktop-section__count-separator">·</span>
            {people().length}
          </span>
        </Show>
      </Show>
    </span>
  );
}
