import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import "../../styles/chat/startup-layout.css";
import "../../styles/chat/message-layout.css";
import "../../styles/chat/text.css";
import "../../styles/chat/grouped.css";
import "../../styles/chat/working-indicator.css";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import { renderIdentityAvatar } from "../../components/identity-avatar-view.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { parseMarkdownJson } from "../../components/markdown-json.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { formatSenderLabel } from "../../lib/chat/sender-label.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveIdentityHue } from "../../lib/identity-avatar.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-content.tsx";
import {
  renderChatAuthorAvatar,
  renderUserAvatarSlot,
  resolveChatDefaultAvatarPlacement,
} from "../chat/components/chat-author-avatar.ts";
import { AssistantAttachments } from "../chat/components/chat-message-attachments-solid.tsx";
import { hasUserFileAttachments } from "../chat/components/chat-message-attachments.ts";
import { MessageImages } from "../chat/components/chat-message-images-solid.tsx";
import { projectMessageMedia } from "../chat/components/chat-message-media.ts";
import { MessageJson, MessageMarkdown } from "../chat/components/chat-message-text-view.tsx";
import { renderChatWorkingIndicator } from "../chat/components/chat-working-indicator.ts";
import type { buildLocalUserMessage } from "../chat/user-message-content.ts";

registerEnglishCatalog(registerNewSessionSetupEnglish);

type DraftAction = { label: string; onClick: () => void; disabled?: boolean };
export type DraftErrorProps = { message: string; action?: DraftAction };
export type NewSessionBodyProps = {
  error: string | null;
  errorAction?: DraftAction;
  pendingMessage: ReturnType<typeof buildLocalUserMessage>;
  userId?: string | null;
  submitting: boolean;
  statusLabel?: string;
  completion?: { label: string; onOpen?: () => void; disabled?: boolean };
  showDraft?: boolean;
  inChat?: boolean;
  renderDraft: () => JSX.Element;
  onOpenImage: (item: ImageLightboxItem) => void;
};

export function DraftError(props: DraftErrorProps) {
  return (
    <div class="callout danger new-session-page__error new-session-page__alert" role="alert">
      <span class="new-session-page__alert-icon" aria-hidden="true">
        <Icon name="alertTriangle" />
      </span>
      <span class="callout__content new-session-page__alert-message">
        {formatUiError(props.message)}
      </span>
      <Show when={props.action}>
        {(action) => (
          <button
            class="btn btn--sm"
            type="button"
            disabled={action().disabled}
            onClick={() => action().onClick()}
          >
            {action().label}
          </button>
        )}
      </Show>
    </div>
  );
}

export function NewSessionBody(props: NewSessionBodyProps) {
  const avatarPlacement = createMemo(() =>
    resolveChatDefaultAvatarPlacement(
      true,
      props.pendingMessage && normalizeMessage(props.pendingMessage).sender ? props.userId : null,
    ),
  );
  // Late cleanup can fail while a replacement submission is still pending.
  return (
    <>
      <div class="sr-only" role="status" aria-live="polite">
        {props.pendingMessage
          ? (props.completion?.label ?? props.statusLabel ?? t("newSession.starting"))
          : undefined}
      </div>
      <div
        class={[
          props.inChat ? "" : "new-session-page__scroll",
          {
            "chat-thread": Boolean(props.pendingMessage || props.inChat),
            "chat-thread--direct":
              Boolean(props.pendingMessage || props.inChat) && avatarPlacement() === "footer",
          },
        ]}
        inert={props.submitting && !props.pendingMessage}
        aria-busy={props.submitting ? "true" : "false"}
        onMouseDown={beginNativeWindowDragFromTopInset}
      >
        <Show when={props.error}>
          {(error) => <DraftError message={error()} action={props.errorAction} />}
        </Show>
        <Show when={props.pendingMessage} fallback={props.renderDraft()}>
          {(message) => (
            <NewSessionSubmission
              message={message()}
              avatarPlacement={avatarPlacement()}
              onOpenImage={props.onOpenImage}
              statusLabel={props.statusLabel}
              completion={props.completion}
            />
          )}
        </Show>
        <Show when={props.pendingMessage && props.showDraft}>{props.renderDraft()}</Show>
      </div>
    </>
  );
}

function NewSessionSubmission(props: {
  message: NonNullable<NewSessionBodyProps["pendingMessage"]>;
  avatarPlacement: "footer" | "gutter";
  onOpenImage: NewSessionBodyProps["onOpenImage"];
  statusLabel?: string;
  completion?: NewSessionBodyProps["completion"];
}) {
  const key = "new-session-submission";
  const normalized = createMemo(() => normalizeMessage(props.message));
  const senderHue = createMemo(() => {
    const sender = normalized().sender;
    return sender ? resolveIdentityHue(sender) : null;
  });
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
        class={[
          "chat-group user",
          {
            "chat-group--with-footer": Boolean(normalized().sender),
            "chat-group--sender-tint": senderHue() !== null,
          },
        ]}
        style={senderHue() === null ? undefined : `--chat-sender-hue: ${senderHue()}`}
        data-chat-row-key={key}
      >
        <Show when={props.avatarPlacement === "gutter" ? normalized().sender : undefined}>
          {(sender) => (
            <LitContent
              value={renderIdentityAvatar(sender(), (view) =>
                renderUserAvatarSlot(view, formatSenderLabel(sender()) ?? ""),
              )}
            />
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
        <Show when={normalized().sender && props.avatarPlacement === "footer"}>
          <div class="chat-group-footer">
            <div class="chat-group-footer__meta">
              <LitContent value={renderChatAuthorAvatar(normalized().sender)} />
            </div>
          </div>
        </Show>
      </div>
      <div class="chat-group assistant chat-group--working">
        <div class="chat-group-messages">
          <Show
            when={props.completion}
            fallback={
              <LitContent
                value={renderChatWorkingIndicator(
                  { kind: "reading-indicator", key, startedAt: props.message.timestamp },
                  { startupLabel: props.statusLabel ?? t("newSession.starting") },
                )}
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
