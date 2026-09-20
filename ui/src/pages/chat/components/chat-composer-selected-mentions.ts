import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import "../../../styles/chat/composer-context-strip.css";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";

class MentionOverflowDirective extends AsyncDirective {
  private element?: HTMLElement;
  private readonly observer =
    typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => this.sync());

  render() {
    return nothing;
  }

  override update(part: ElementPart) {
    this.element = part.element instanceof HTMLElement ? part.element : undefined;
    this.schedule();
    return nothing;
  }

  private schedule() {
    // Element directives run before their children commit, including retained lists.
    queueMicrotask(() => {
      if (!this.isConnected || !this.element?.isConnected) {
        return;
      }
      this.observer?.observe(this.element);
      this.sync();
      void document.fonts?.ready.then(() => this.sync());
    });
  }

  private sync() {
    const element = this.element;
    if (!this.isConnected || !element?.isConnected) {
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
  }

  protected override disconnected() {
    this.observer?.disconnect();
  }

  protected override reconnected() {
    this.schedule();
  }
}

const mentionOverflow = directive(MentionOverflowDirective);

export function renderSelectedHumanMentions(
  text: string,
  mentions: readonly HumanMention[] | undefined,
  onRemove: () => void,
  avatarUrls?: ReadonlyMap<string, string>,
) {
  if (!mentions?.length) {
    return nothing;
  }
  const people = mentions.map((mention) => {
    const label = text.slice(mention.start, mention.end);
    return { profileId: mention.profileId, label, name: label.replace(/^@/u, "") };
  });
  return html`<div class="chat-reply-preview composer-context-strip" role="status">
    <span class="composer-context-strip__label">
      <span class="composer-context-strip__icon" aria-hidden="true">${icons.bell}</span>
      <span class="composer-context-strip__label-text">${t("chat.mentions.selectedLabel")}</span>
    </span>
    <span class="sr-only">${people.map((person) => person.name).join(", ")}</span>
    <span class="composer-context-strip__people" aria-hidden="true" ${mentionOverflow()}>
      ${people.map(
        (person, index) => html`<span class="composer-context-strip__person" title=${person.label}>
          ${renderChatAuthorAvatar({ id: person.profileId, name: person.name, identity: { type: "profile", id: person.profileId }, profileAvatarUrl: avatarUrls?.get(person.profileId) })}
          <bdi class="composer-context-strip__person-name"
            >${person.name}${index < people.length - 1 ? "," : ""}</bdi
          >
        </span>`,
      )}
      <span class="composer-context-strip__more" dir="ltr" hidden></span>
    </span>
    <button
      type="button"
      class="chat-reply-preview__dismiss composer-context-strip__dismiss"
      aria-label=${t("chat.mentions.remove")}
      @click=${onRemove}
    >
      ${icons.x}
    </button>
  </div>`;
}
