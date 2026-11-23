import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ChatMobilePeopleMentions } from "../chat-mobile-people-mentions.ts";
import type {
  ChatMobilePeople,
  ChatMobilePeopleMention,
  ChatMobilePerson,
} from "../chat-mobile-people.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar-view.tsx";
import { ChatSessionSharingOptions } from "./chat-session-sharing-options.tsx";
import type { PreparedChatSessionSharing } from "./chat-session-sharing-shared.tsx";
import { canManageChatSessionSharing } from "./chat-session-sharing-shared.tsx";
import "../../../styles/chat/mobile-people.css";

registerEnglishCatalog(registerChatSessionEnglish);

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
    <span
      ref={createTextOverflow(() => props.person.firstName)}
      class="chat-mobile-people__name"
      aria-label={props.person.label}
      title={props.person.label}
    >
      {props.person.firstName}
    </span>
  );
}

function PeopleSection(props: {
  title: string;
  people: readonly ChatMobilePerson[];
  labels: ChatMobilePeopleLabels;
  showCount?: boolean;
  partial?: boolean;
  onMention?: ChatMobilePeopleBodyProps["onMention"];
}) {
  return (
    <section class="chat-mobile-people__section" aria-label={props.title}>
      <h3>
        {props.title}
        <Show when={props.showCount && !props.partial}>
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
          partial={!props.people.participantsComplete}
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

/** Optional People destination; the retained mobile host owns activation and commands. */
export function ChatPaneMobilePeople(props: {
  header: {
    mobilePeople?: ChatMobilePeople;
    mobilePeopleMentions?: ChatMobilePeopleMentions;
    mobileSharing?: PreparedChatSessionSharing;
  };
  controls: string;
  onClose: () => void;
  onOpenSharing: () => void;
}) {
  const labels = {
    get people() {
      return t("chat.sessionHeader.people");
    },
    get viewingNow() {
      return t("activityFeed.viewingNow");
    },
    get creator() {
      return t("chat.sessionSharing.creator");
    },
    get owner() {
      return t("chat.sessionSharing.owner");
    },
    get participants() {
      return t("chat.sessionHeader.peopleParticipants");
    },
    get mention() {
      return t("chat.sessionHeader.mention");
    },
    mentionPerson: (name: string) => t("chat.sessionHeader.mentionPerson", { name }),
    morePeople: (count: number) => t("chat.sessionHeader.morePeople", { count: String(count) }),
  };
  const sharing = () => props.header.mobileSharing;
  const sharingAvailable = () => {
    const session = sharing()?.session;
    return Boolean(session && canManageChatSessionSharing(session));
  };
  return (
    <div id={props.controls}>
      <Show when={props.header.mobilePeopleMentions?.status === "loading"}>
        <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
      </Show>
      <Show
        when={
          props.header.mobilePeopleMentions?.status === "error" ||
          props.header.mobilePeopleMentions?.status === "unavailable" ||
          props.header.mobilePeopleMentions?.status === "insert-rejected"
        }
      >
        <p role="alert">
          {props.header.mobilePeopleMentions?.status === "insert-rejected"
            ? t("chat.sessionHeader.mentionRejected")
            : (props.header.mobilePeopleMentions?.error ?? t("chat.mentions.unavailable"))}
          <button
            type="button"
            class="btn btn--ghost"
            onClick={() => void props.header.mobilePeopleMentions?.request()}
          >
            {t("common.retry")}
          </button>
        </p>
      </Show>
      <Show when={props.header.mobilePeopleMentions?.truncated}>
        <p role="status">{t("chat.sessionHeader.mentionsTruncated")}</p>
      </Show>
      <Show when={props.header.mobilePeople}>
        {(data) => (
          <ChatMobilePeopleBody
            people={data()}
            labels={labels}
            onMention={(person) => {
              if (props.header.mobilePeopleMentions?.insert(person.profileId)) {
                // Native close restores its source synchronously; the queued
                // composer focus runs afterwards. Do not add another focus task.
                props.onClose();
              }
            }}
            sharingOptions={
              <Show when={sharingAvailable()}>
                <ChatSessionSharingOptions
                  visibility={sharing()?.session.visibility ?? "shared"}
                  publicShare={Boolean(sharing()?.state?.result?.publicShare)}
                  openDisabledReason={sharing()?.openDisabledReason}
                  onOpen={props.onOpenSharing}
                />
              </Show>
            }
          />
        )}
      </Show>
    </div>
  );
}
