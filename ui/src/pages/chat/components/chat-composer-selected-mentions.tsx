import { For, onCleanup } from "solid-js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import "../../../styles/chat/composer-context-strip.css";
import { LitContent, solidTemplate } from "./chat-composer-controls.ts";

function mentionOverflow() {
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

export function renderSelectedHumanMentionsSolid(
  text: string,
  mentions: readonly HumanMention[] | undefined,
  onRemove: () => void,
  avatarUrls?: ReadonlyMap<string, string>,
) {
  if (!mentions?.length) {
    return null;
  }
  const recipients = new Map(mentions.map((mention) => [mention.profileId, mention]));
  const people = [...recipients.values()].map((mention) => {
    const label = text.slice(mention.start, mention.end);
    return { profileId: mention.profileId, label, name: label.replace(/^@/u, "") };
  });
  return (
    <div class="chat-reply-preview composer-context-strip" role="status">
      <span class="composer-context-strip__label">
        <span class="composer-context-strip__icon" aria-hidden="true">
          <LitContent value={icons.bell} />
        </span>
        <span class="composer-context-strip__label-text">{t("chat.mentions.selectedLabel")}</span>
      </span>
      <span class="sr-only">{people.map((person) => person.name).join(", ")}</span>
      <span class="composer-context-strip__people" aria-hidden="true" ref={mentionOverflow()}>
        <For keyed={(item) => item} each={people}>
          {(menuItem, menuIndex) => (
            <span class="composer-context-strip__person" title={menuItem().label}>
              <LitContent
                value={renderChatAuthorAvatar({
                  id: menuItem().profileId,
                  name: menuItem().name,
                  identity: { type: "profile", id: menuItem().profileId },
                  profileAvatarUrl: avatarUrls?.get(menuItem().profileId),
                })}
              />
              <bdi class="composer-context-strip__person-name">
                {menuItem().name}
                {menuIndex() < people.length - 1 ? "," : ""}
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
        onClick={onRemove}
      >
        <LitContent value={icons.x} />
      </button>
    </div>
  );
}

function renderSelectedHumanMentionsContent(props: {
  args: Parameters<typeof renderSelectedHumanMentionsSolid>;
}) {
  return <>{renderSelectedHumanMentionsSolid(...props.args)}</>;
}

export function renderSelectedHumanMentions(
  ...args: Parameters<typeof renderSelectedHumanMentionsSolid>
) {
  return solidTemplate(renderSelectedHumanMentionsContent, { args });
}
