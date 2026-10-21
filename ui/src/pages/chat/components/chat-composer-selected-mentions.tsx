import { createMemo, For, onSettled, Show, type Accessor } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import "../../../styles/chat/composer-context-strip.css";
import { ComposerContent } from "./chat-composer-content.tsx";

registerEnglishCatalog(registerChatComposerEnglish);

type MentionPerson = { profileId: string; label: string; name: string; avatarUrl?: string };

function mentionOverflow(
  readPeople: Accessor<readonly MentionPerson[]>,
  personElements: Map<string, HTMLElement>,
  readMore: () => HTMLElement,
) {
  let element: HTMLElement | undefined;
  let disposed = false;
  const sync = () => {
    if (disposed || !element?.isConnected) {
      return;
    }
    const people = readPeople().flatMap((person) => personElements.get(person.profileId) ?? []);
    const more = readMore();
    if (!people.length || !more) {
      return;
    }
    for (const person of people) {
      person.hidden = false;
      person.style.maxWidth = "";
    }
    more.hidden = false;
    more.textContent = `+${people.length - 1}`;
    const gap = Number.parseFloat(getComputedStyle(element).columnGap);
    const widths = people.map((person) => person.getBoundingClientRect().width);
    const available = element.clientWidth;
    const moreWidth = more.getBoundingClientRect().width;
    let visible = people.length;
    if (widths.reduce((sum, width) => sum + width, 0) + gap * (people.length - 1) > available) {
      visible = 1;
      let used = widths[0]!;
      while (
        visible < people.length &&
        used + gap + widths[visible]! + gap + moreWidth <= available
      ) {
        used += gap + widths[visible]!;
        visible += 1;
      }
    }
    people.forEach((person, index) => {
      person.hidden = index >= visible;
    });
    more.hidden = visible === people.length;
    more.textContent = `+${people.length - visible}`;
    more.title = people
      .slice(visible)
      .map((person) => person.title)
      .join(", ");
    people[0]!.style.maxWidth = `${Math.max(0, available - (more.hidden ? 0 : moreWidth + gap))}px`;
  };
  // Re-observe after recipient changes; native resize delivery sees committed keyed rows.
  createResizeObserver(() => {
    readPeople();
    return element ? [element] : [];
  }, sync);
  onSettled(() => {
    sync();
    if (document.fonts?.status === "loading") {
      void document.fonts.ready.then(sync);
    }
    return () => {
      disposed = true;
    };
  });
  return (node: HTMLElement) => {
    element = node;
  };
}

type SelectedHumanMentionsProps = {
  text: string;
  mentions: readonly HumanMention[] | undefined;
  onRemove: () => void;
  avatarUrls?: ReadonlyMap<string, string>;
};

export function SelectedHumanMentions(props: SelectedHumanMentionsProps) {
  const personElements = new Map<string, HTMLElement>();
  let more!: HTMLSpanElement;
  const people = createMemo(
    () => {
      const recipients = new Map(props.mentions?.map((mention) => [mention.profileId, mention]));
      return [...recipients.values()].map((mention) => {
        const label = props.text.slice(mention.start, mention.end);
        return {
          profileId: mention.profileId,
          label,
          name: label.replace(/^@/u, ""),
          avatarUrl: props.avatarUrls?.get(mention.profileId),
        };
      });
    },
    {
      equals: (previous, next) =>
        previous.length === next.length &&
        previous.every((person, index) => {
          const current = next[index]!;
          return (
            person.profileId === current.profileId &&
            person.label === current.label &&
            person.avatarUrl === current.avatarUrl
          );
        }),
    },
  );
  return (
    <Show when={people().length > 0}>
      <div class="chat-reply-preview composer-context-strip" role="status">
        <span class="composer-context-strip__label">
          <span class="composer-context-strip__icon" aria-hidden="true">
            <ComposerContent>
              <Icon name="bell" />
            </ComposerContent>
          </span>
          <span class="composer-context-strip__label-text">{t("chat.mentions.selectedLabel")}</span>
        </span>
        <span class="sr-only">
          {people()
            .map((person) => person.name)
            .join(", ")}
        </span>
        <span
          class="composer-context-strip__people"
          aria-hidden="true"
          ref={mentionOverflow(people, personElements, () => more)}
        >
          <For keyed={(person) => person.profileId} each={people()}>
            {(person, index) => (
              <span
                ref={[
                  elementRef((node) => {
                    const initialProfileId = person().profileId;
                    personElements.set(initialProfileId, node);
                    return () => personElements.delete(initialProfileId);
                  }),
                ]}
                class="composer-context-strip__person"
                title={person().label}
              >
                <ChatAuthorAvatar
                  sender={{
                    id: person().profileId,
                    name: person().name,
                    identity: { type: "profile", id: person().profileId },
                    profileAvatarUrl: person().avatarUrl,
                  }}
                />
                <bdi class="composer-context-strip__person-name">
                  {person().name}
                  {index() < people().length - 1 ? "," : ""}
                </bdi>
              </span>
            )}
          </For>
          <span
            ref={(node) => (more = node)}
            class="composer-context-strip__more"
            dir="ltr"
            hidden
          />
        </span>
        <button
          type="button"
          class="chat-reply-preview__dismiss composer-context-strip__dismiss"
          aria-label={t("chat.mentions.remove")}
          onClick={() => props.onRemove()}
        >
          <ComposerContent>
            <Icon name="x" />
          </ComposerContent>
        </button>
      </div>
    </Show>
  );
}
