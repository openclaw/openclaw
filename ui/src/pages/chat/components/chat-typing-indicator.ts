import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { i18n, t } from "../../../i18n/index.ts";
import { resolveIdentityHue } from "../../../lib/identity-avatar.ts";
import { renderChatAvatar } from "../chat-avatar.ts";
import type { ChatTypingActorView, ChatTypingOverflow } from "../chat-typing-presence.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";

let listFormatter: Intl.ListFormat | undefined;
let listLocale: string | undefined;

function typingSentence(names: readonly string[]) {
  const locale = i18n.getLocale();
  if (!listFormatter || listLocale !== locale) {
    listLocale = locale;
    listFormatter = new Intl.ListFormat(locale, { type: "conjunction", style: "long" });
  }
  const visibleNames = names.length > 3 ? names.slice(0, 2) : names;
  const items = [...visibleNames];
  if (names.length > 3) {
    items.push(t("chat.sessionSuggestions.typingOthers", { count: String(names.length - 2) }));
  }
  let nameIndex = 0;
  const nameParts = listFormatter
    .formatToParts(items)
    .map((part) =>
      part.type === "element" && nameIndex++ < visibleNames.length
        ? html`<bdi class="agent-chat__typing-name" title=${part.value}>${part.value}</bdi>`
        : part.value,
    );
  const key =
    names.length === 1 ? "chat.sessionSuggestions.typing" : "chat.sessionSuggestions.typingMany";
  // Translate the sentence around a trusted marker; user names never become markup
  // or participate in placeholder parsing. Each visible name can shrink independently.
  const marker = "\u0001";
  const template = t(key, { name: marker, names: marker });
  return {
    text: t(key, { name: listFormatter.format(items), names: listFormatter.format(items) }),
    content: template
      .split(marker)
      .map((part, index) => (index ? html`${nameParts}${part}` : part)),
  };
}

export function renderChatTypingIndicator(
  actors: readonly ChatTypingActorView[] | undefined,
  avatarPlacement: "gutter" | "footer" | "none" = "gutter",
  overflow?: ChatTypingOverflow,
) {
  if (!actors?.length) {
    return null;
  }
  const active = actors.filter((actor) => !actor.paused);
  const peers = actors.slice(2, 7);
  const activeNames = peers.map((actor) => actor.label);
  const groupLabel = overflow?.several
    ? {
        text: t("chat.sessionSuggestions.typingSeveral"),
        content: t("chat.sessionSuggestions.typingSeveral"),
      }
    : activeNames.length
      ? typingSentence(activeNames)
      : undefined;
  const groupDescription =
    avatarPlacement === "none" && peers.length
      ? peers
          .map((actor) => `${actor.label} — ${t("chat.sessionSuggestions.typingDraftState")}`)
          .join("; ")
      : undefined;
  const status =
    active.length === 0
      ? ""
      : active.length === 1
        ? t("chat.sessionSuggestions.typing", { name: active[0]?.label ?? "" })
        : t("chat.sessionSuggestions.typingMany", {
            names: active.map((actor) => actor.label).join(", "),
          });
  return html`<div class="agent-chat__typing-indicator agent-chat__typing-indicator--outside">
    ${repeat(
      actors.slice(0, 2),
      (actor) => actor.id,
      (actor) => {
        // session.typing actors are authenticated Gateway profiles, like sent user turns.
        const sender = {
          id: actor.id,
          name: actor.label,
          identity: { type: "profile" as const, id: actor.id },
        };
        const preview = actor.preview?.trim() ? actor.preview : undefined;
        return html`<div
          class="agent-chat__typing-row"
          ?data-exiting=${actor.exitDurationMs !== undefined}
          style=${actor.exitDurationMs === undefined ? nothing : `--chat-typing-exit-duration: ${actor.exitDurationMs}ms`}
        >
          <div class="agent-chat__typing-row-content">
            <div
              class="chat-group user chat-group--peer chat-group--sender-tint chat-group--with-footer chat-group--typing"
              style=${`--chat-sender-hue: ${resolveIdentityHue(sender)}`}
              aria-live="off"
            >
              <div class="chat-group-messages">
                <div class="chat-bubble ${preview ? "agent-chat__typing-preview-bubble" : ""}">
                  <div class="chat-message-avatar-anchor">
                    ${
                      preview
                        ? html`<span
                            class="chat-text agent-chat__typing-preview-text"
                            dir="auto"
                            ?data-paused=${actor.paused}
                            >${preview}</span
                          >`
                        : html`<span class="agent-chat__typing-bubble" aria-hidden="true"
                            ><span></span><span></span><span></span
                          ></span>`
                    }
                    ${avatarPlacement === "gutter" ? renderChatAvatar("user", undefined, undefined, sender) : null}
                  </div>
                </div>
              </div>
              <div class="chat-group-footer chat-group-footer--persistent-identity">
                <div class="chat-group-footer__meta">
                  ${avatarPlacement === "footer" ? renderChatAuthorAvatar(sender) : null}
                  <span class="chat-sender-name agent-chat__typing-preview-label"
                    >${actor.label}</span
                  >
                  <span
                    class="agent-chat__typing-state agent-chat__typing-text"
                    ?data-typing=${!actor.paused}
                    >${t(actor.paused ? "chat.sessionSuggestions.pausedDraftState" : "chat.sessionSuggestions.typingDraftState")}</span
                  >
                </div>
              </div>
            </div>
          </div>
        </div>`;
      },
    )}
    ${
      peers.length
        ? html`<div class="agent-chat__typing-row agent-chat__typing-group">
            <div class="agent-chat__typing-row-content">
              <div
                class="agent-chat__typing-overflow ${avatarPlacement === "none" ? "agent-chat__typing-overflow--no-avatars" : ""}"
                role="group"
                aria-label=${groupDescription ? `${t("chat.sessionSuggestions.otherCollaborators")}: ${groupDescription}` : t("chat.sessionSuggestions.otherCollaborators")}
                title=${groupDescription ?? nothing}
                aria-live="off"
              >
                ${
                  avatarPlacement === "none"
                    ? nothing
                    : html`<span class="agent-chat__typing-identities">
                        ${repeat(
                          peers,
                          (actor) => actor.id,
                          (actor) => html`<span class="agent-chat__typing-person">
                            ${renderChatAuthorAvatar({ id: actor.id, name: actor.label, identity: { type: "profile", id: actor.id } })}
                          </span>`,
                        )}
                      </span>`
                }
                <span class="agent-chat__typing-summary"
                  ><span class="agent-chat__typing-text" data-typing
                    >${groupLabel?.content}</span
                  ></span
                >
              </div>
            </div>
          </div>`
        : nothing
    }
    <span class="sr-only" role="status"
      >${[status, overflow?.several ? groupLabel?.text : ""].filter(Boolean).join(" ")}</span
    >
  </div>`;
}
