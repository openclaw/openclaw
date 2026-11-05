import { createMemo, For, Show } from "solid-js";
import { personActivityLink } from "../../../components/person-activity-link.ts";
import { sessionParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { PeopleAvatar, uniquePeople, type ChatDetailsPeopleProps } from "./chat-details-people.tsx";

/** Desktop list body. No roster loading, permission inference or disclosure state. */
export function ChatDetailsPeople(props: ChatDetailsPeopleProps) {
  const people = createMemo(() => uniquePeople(props.people));
  const ownerKey = () => props.ownerIdentity && sessionParticipantIdentityKey(props.ownerIdentity);
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
