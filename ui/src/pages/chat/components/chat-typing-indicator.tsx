import { createMemo, For, Show } from "solid-js";
import { resolveIdentityHue } from "../../../lib/identity-avatar.ts";
import { getLocale, t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import { renderChatAvatar } from "../chat-avatar.ts";
import type { ChatTypingActorView, ChatTypingOverflow } from "../chat-typing-presence.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";

let listFormatter: Intl.ListFormat | undefined;
let listLocale: string | undefined;

function typingSentence(names: readonly string[]) {
  const locale = getLocale();
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
  const nameParts = listFormatter.formatToParts(items).map((part) =>
    part.type === "element" && nameIndex++ < visibleNames.length ? (
      <bdi class="agent-chat__typing-name" title={part.value}>
        {part.value}
      </bdi>
    ) : (
      part.value
    ),
  );
  const key =
    names.length === 1 ? "chat.sessionSuggestions.typing" : "chat.sessionSuggestions.typingMany";
  // Translate around a trusted marker; user names stay text and never become markup.
  const marker = "\u0001";
  const template = t(key, { name: marker, names: marker });
  return {
    text: t(key, { name: listFormatter.format(items), names: listFormatter.format(items) }),
    content: template.split(marker).map((part, index) =>
      index ? (
        <>
          {nameParts}
          {part}
        </>
      ) : (
        part
      ),
    ),
  };
}

type AvatarPlacement = "gutter" | "footer" | "none";

function TypingRow(props: { actor: ChatTypingActorView; avatarPlacement: AvatarPlacement }) {
  // session.typing actors are authenticated Gateway profiles, like sent user turns.
  const sender = () => ({
    id: props.actor.id,
    name: props.actor.label,
    identity: { type: "profile" as const, id: props.actor.id },
  });
  const preview = () => (props.actor.preview?.trim() ? props.actor.preview : undefined);
  const cursor = () =>
    Math.min(preview()?.length ?? 0, Math.max(0, props.actor.cursor ?? preview()?.length ?? 0));
  return (
    <div
      class="agent-chat__typing-row"
      data-exiting={props.actor.exitDurationMs !== undefined ? "" : undefined}
      style={
        props.actor.exitDurationMs === undefined
          ? undefined
          : `--chat-typing-exit-duration: ${props.actor.exitDurationMs}ms`
      }
    >
      <div class="agent-chat__typing-row-content">
        <div
          class="chat-group user chat-group--peer chat-group--sender-tint chat-group--with-footer chat-group--typing"
          style={`--chat-sender-hue: ${resolveIdentityHue(sender())}`}
          aria-live="off"
        >
          <div class="chat-group-messages">
            <div
              class={["chat-bubble", { "agent-chat__typing-preview-bubble": Boolean(preview()) }]}
            >
              <div class="chat-message-avatar-anchor">
                <Show
                  when={preview()}
                  fallback={
                    <span class="agent-chat__typing-bubble" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  }
                >
                  <span
                    class="chat-text agent-chat__typing-preview-text"
                    dir="auto"
                    data-paused={props.actor.paused ? "" : undefined}
                  >
                    {preview()?.slice(0, cursor())}
                    <span class="agent-chat__typing-caret" aria-hidden="true" />
                    {preview()?.slice(cursor())}
                  </span>
                </Show>
                <Show when={props.avatarPlacement === "gutter"}>
                  <LitContent value={renderChatAvatar("user", undefined, undefined, sender())} />
                </Show>
              </div>
            </div>
          </div>
          <div class="chat-group-footer chat-group-footer--persistent-identity">
            <div class="chat-group-footer__meta">
              <Show when={props.avatarPlacement === "footer"}>
                <LitContent value={renderChatAuthorAvatar(sender())} />
              </Show>
              <span class="chat-sender-name agent-chat__typing-preview-label">
                {props.actor.label}
              </span>
              <span
                class="agent-chat__typing-state agent-chat__typing-text"
                data-typing={props.actor.paused ? undefined : ""}
              >
                {t(
                  props.actor.paused
                    ? "chat.sessionSuggestions.pausedDraftState"
                    : "chat.sessionSuggestions.typingDraftState",
                )}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatTypingIndicator(props: {
  actors: readonly ChatTypingActorView[] | undefined;
  avatarPlacement?: AvatarPlacement;
  overflow?: ChatTypingOverflow;
}) {
  const placement = () => props.avatarPlacement ?? "gutter";
  const peers = createMemo(() => props.actors?.slice(2, 7) ?? []);
  const groupLabel = createMemo(() =>
    props.overflow?.several
      ? {
          text: t("chat.sessionSuggestions.typingSeveral"),
          content: t("chat.sessionSuggestions.typingSeveral"),
        }
      : peers().length
        ? typingSentence(peers().map((actor) => actor.label))
        : undefined,
  );
  const groupDescription = () =>
    placement() === "none" && peers().length
      ? peers()
          .map((actor) => `${actor.label} — ${t("chat.sessionSuggestions.typingDraftState")}`)
          .join("; ")
      : undefined;
  const status = () => {
    const active = props.actors?.filter((actor) => !actor.paused) ?? [];
    return props.overflow?.several
      ? (groupLabel()?.text ?? "")
      : active.length === 0
        ? ""
        : active.length === 1
          ? t("chat.sessionSuggestions.typing", { name: active[0]?.label ?? "" })
          : t("chat.sessionSuggestions.typingMany", {
              names: active.map((actor) => actor.label).join(", "),
            });
  };
  return (
    <Show when={props.actors?.length}>
      <div class="agent-chat__typing-indicator agent-chat__typing-indicator--outside">
        <For each={props.actors?.slice(0, 2)} keyed={(actor) => actor.id}>
          {(actor) => <TypingRow actor={actor()} avatarPlacement={placement()} />}
        </For>
        <Show when={peers().length}>
          <div class="agent-chat__typing-row agent-chat__typing-group">
            <div class="agent-chat__typing-row-content">
              <div
                class={[
                  "agent-chat__typing-overflow",
                  { "agent-chat__typing-overflow--no-avatars": placement() === "none" },
                ]}
                role="group"
                aria-label={
                  groupDescription()
                    ? `${t("chat.sessionSuggestions.otherCollaborators")}: ${groupDescription()}`
                    : t("chat.sessionSuggestions.otherCollaborators")
                }
                title={groupDescription()}
                aria-live="off"
              >
                <Show when={placement() !== "none"}>
                  <span class="agent-chat__typing-identities">
                    <For each={peers()} keyed={(actor) => actor.id}>
                      {(actor) => (
                        <span class="agent-chat__typing-person">
                          <LitContent
                            value={renderChatAuthorAvatar({
                              id: actor().id,
                              name: actor().label,
                              identity: { type: "profile", id: actor().id },
                            })}
                          />
                        </span>
                      )}
                    </For>
                  </span>
                </Show>
                <span class="agent-chat__typing-summary">
                  <span class="agent-chat__typing-text" data-typing="">
                    {groupLabel()?.content}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </Show>
        <span class="sr-only" role="status">
          {status()}
        </span>
      </div>
    </Show>
  );
}
