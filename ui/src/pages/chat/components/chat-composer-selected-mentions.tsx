import { createEffect, createMemo, For, onCleanup, Show, type Accessor } from "solid-js";
import { icons } from "../../../components/icons.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import "../../../styles/chat/composer-context-strip.css";
import { solidTemplate } from "./chat-composer-controls.ts";
import { LitContent } from "./chat-composer-interop.tsx";

type MentionPerson = { profileId: string; label: string; name: string; avatarUrl?: string };

function mentionOverflow(readPeople: Accessor<readonly MentionPerson[]>) {
  let element: HTMLElement | undefined;
  let disposed = false;
  const sync = () => {
    if (disposed || !element?.isConnected) {
      return;
    }
    const people = [...element.querySelectorAll<HTMLElement>(".composer-context-strip__person")];
    const more = element.querySelector<HTMLElement>(".composer-context-strip__more");
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
  // Measure the current recipients after the keyed list and avatars have committed.
  createEffect(readPeople, sync);
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
  onCleanup(() => {
    disposed = true;
    observer?.disconnect();
  });
  return (node: HTMLElement) => {
    element = node;
    observer?.observe(node);
    queueMicrotask(() => {
      sync();
      if (document.fonts?.status === "loading") {
        void document.fonts.ready.then(sync);
      }
    });
  };
}

type SelectedHumanMentionsProps = {
  text: string;
  mentions: readonly HumanMention[] | undefined;
  onRemove: () => void;
  avatarUrls?: ReadonlyMap<string, string>;
};

export function SelectedHumanMentions(props: SelectedHumanMentionsProps) {
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
            <LitContent value={icons.bell} />
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
          ref={mentionOverflow(people)}
        >
          <For keyed={(person) => person.profileId} each={people()}>
            {(person, index) => (
              <span class="composer-context-strip__person" title={person().label}>
                <LitContent
                  value={renderChatAuthorAvatar({
                    id: person().profileId,
                    name: person().name,
                    identity: { type: "profile", id: person().profileId },
                    profileAvatarUrl: person().avatarUrl,
                  })}
                />
                <bdi class="composer-context-strip__person-name">
                  {person().name}
                  {index() < people().length - 1 ? "," : ""}
                </bdi>
              </span>
            )}
          </For>
          <span class="composer-context-strip__more" dir="ltr" hidden></span>
        </span>
        <button
          type="button"
          class="chat-reply-preview__dismiss composer-context-strip__dismiss"
          aria-label={t("chat.mentions.remove")}
          onClick={() => props.onRemove()}
        >
          <LitContent value={icons.x} />
        </button>
      </div>
    </Show>
  );
}

export function renderSelectedHumanMentions(
  text: string,
  mentions: readonly HumanMention[] | undefined,
  onRemove: () => void,
  avatarUrls?: ReadonlyMap<string, string>,
) {
  return solidTemplate(SelectedHumanMentions, { text, mentions, onRemove, avatarUrls });
}
