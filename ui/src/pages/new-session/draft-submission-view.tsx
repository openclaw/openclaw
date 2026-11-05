import { createMemo, Show } from "solid-js";
import { parseMarkdownJson } from "../../components/markdown-json.ts";
import { IdentityAvatar } from "../../components/solid/identity-avatar.tsx";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { formatSenderLabel } from "../../lib/chat/sender-label.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { participantPalette } from "../../lib/reactive/participant-palette.ts";
import { ChatAuthorAvatar, UserAvatarSlot } from "../chat/components/chat-author-avatar.ts";
import { hasUserFileAttachments } from "../chat/components/chat-message-attachments.ts";
import { AssistantAttachments, MessageImages } from "../chat/components/chat-message-deferred.tsx";
import { projectMessageMedia } from "../chat/components/chat-message-media.ts";
import { MessageJson, MessageMarkdown } from "../chat/components/chat-message-text-view.tsx";
import { ChatWorkingIndicator } from "../chat/components/chat-working-indicator.tsx";
import type { NewSessionBodyProps } from "./draft-body.solid.tsx";

export function NewSessionSubmission(props: {
  message: NonNullable<NewSessionBodyProps["pendingMessage"]>;
  avatarPlacement: "footer" | "gutter";
  onOpenImage: NewSessionBodyProps["onOpenImage"];
  statusLabel?: string;
  completion?: NewSessionBodyProps["completion"];
}) {
  const key = "new-session-submission";
  const normalized = createMemo(() => normalizeMessage(props.message));
  const media = createMemo(() => projectMessageMedia(props.message, normalized().content));
  const hasUserFiles = createMemo(() => hasUserFileAttachments(media().attachments));
  const markdown = createMemo(() => resolveMessageDisplayMarkdown(props.message, normalized()));
  const json = createMemo(() => parseMarkdownJson(markdown()));
  const imageOptions = createMemo(() => ({ onOpenImage: props.onOpenImage }));
  const textOptions = { role: "user", isStreaming: false };
  const markdownOptions = { codeBlockChrome: "none" } as const;
  // Keep Markdown passive until Chat mounts its interaction owners. Uploaded
  // images have their own lightbox handler and remain interactive while pending.
  return (
    <div class="new-session-page__starting chat-thread-inner">
      <div
        class="chat-group user chat-group--with-footer"
        style={participantPalette.read()?.style(null)}
        data-chat-row-key={key}
      >
        <Show when={props.avatarPlacement === "gutter" ? normalized().sender : undefined}>
          {(sender) => (
            <IdentityAvatar identity={sender()}>
              {(view) => <UserAvatarSlot view={view()} label={formatSenderLabel(sender()) ?? ""} />}
            </IdentityAvatar>
          )}
        </Show>
        <div class="chat-group-messages">
          <div
            class={[
              "chat-bubble",
              {
                "chat-bubble--with-images": Boolean(media().images.length || hasUserFiles()),
                "chat-bubble--with-files": hasUserFiles(),
              },
            ]}
            data-message-id={key}
            data-message-text={markdown() || undefined}
          >
            <MessageImages images={media().images} options={imageOptions()} />
            <AssistantAttachments
              attachments={media().attachments}
              options={imageOptions()}
              inlinePlayback={false}
            />
            <Show
              when={json()}
              fallback={
                <Show when={markdown()}>
                  <MessageMarkdown
                    markdown={markdown()}
                    messageKey={key}
                    options={textOptions}
                    markdownOptions={markdownOptions}
                  />
                </Show>
              }
            >
              {(value) => (
                <MessageJson
                  json={value()}
                  messageKey={key}
                  options={textOptions}
                  markdownOptions={markdownOptions}
                />
              )}
            </Show>
          </div>
        </div>
        {/* Chat reserves this row on every user turn; omitting it here would
            move the working indicator down when Chat replaces this preview. */}
        <div class="chat-group-footer">
          <Show when={props.avatarPlacement === "footer" ? normalized().sender : undefined}>
            {(sender) => (
              <div class="chat-group-footer__meta">
                <ChatAuthorAvatar sender={sender()} />
              </div>
            )}
          </Show>
        </div>
      </div>
      <div class="chat-group assistant chat-group--working">
        <div class="chat-group-messages">
          <Show
            when={props.completion}
            fallback={
              <ChatWorkingIndicator
                part={{ kind: "reading-indicator", key, startedAt: props.message.timestamp }}
                options={{ startupLabel: props.statusLabel ?? t("newSession.starting") }}
              />
            }
          >
            {(completion) => (
              <div class="callout" role="status">
                <span class="callout__content">{completion().label}</span>
                <Show when={completion().onOpen}>
                  <button
                    class="btn btn--sm"
                    type="button"
                    disabled={completion().disabled}
                    onClick={() => completion().onOpen?.()}
                  >
                    {t("sessionsView.openSession")}
                  </button>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
