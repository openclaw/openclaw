import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../../i18n/index.ts";
import { resolveIdentityHue } from "../../../lib/identity-avatar.ts";
import { renderChatAvatar } from "../chat-avatar.ts";
import type { ChatTypingActorView } from "../chat-typing-presence.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";

export function renderChatTypingIndicator(
  actors: readonly ChatTypingActorView[] | undefined,
  avatarPlacement: "gutter" | "footer" | "none" = "gutter",
) {
  if (!actors?.length) {
    return null;
  }
  const active = actors.filter((actor) => !actor.paused);
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
      actors,
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
                  <span class="agent-chat__typing-state"
                    >${t(actor.paused ? "chat.sessionSuggestions.pausedDraftState" : "chat.sessionSuggestions.typingDraftState")}</span
                  >
                </div>
              </div>
            </div>
          </div>
        </div>`;
      },
    )}
    <span class="sr-only" role="status">${status}</span>
  </div>`;
}
