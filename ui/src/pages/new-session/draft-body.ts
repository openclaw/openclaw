import { html, nothing, type TemplateResult } from "lit";
import "../../styles/chat/startup-layout.css";
import "../../styles/chat/message-layout.css";
import "../../styles/chat/text.css";
import "../../styles/chat/grouped.css";
import "../../styles/chat/working-indicator.css";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import { icons } from "../../components/icons.ts";
import { resolveIdentityAvatarView } from "../../components/identity-avatar-view.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { parseMarkdownJson } from "../../components/markdown-json.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { formatSenderLabel } from "../../lib/chat/sender-label.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveIdentityHue } from "../../lib/identity-avatar.ts";
import {
  renderChatAuthorAvatar,
  renderUserAvatarSlot,
  resolveChatDefaultAvatarPlacement,
} from "../chat/components/chat-author-avatar.ts";
import { renderAssistantAttachments } from "../chat/components/chat-message-attachments.ts";
import { renderMessageImages } from "../chat/components/chat-message-images.ts";
import { projectMessageMedia } from "../chat/components/chat-message-media.ts";
import { renderMessageJson, renderMessageMarkdown } from "../chat/components/chat-message-text.ts";
import { renderChatWorkingIndicator } from "../chat/components/chat-working-indicator.ts";
import type { buildLocalUserMessage } from "../chat/user-message-content.ts";

registerNewSessionSetupEnglish();

export function renderDraftError(
  message: string,
  action?: { label: string; onClick: () => void; disabled?: boolean },
) {
  return html`
    <div class="callout danger new-session-page__error new-session-page__alert" role="alert">
      <span class="new-session-page__alert-icon" aria-hidden="true">${icons.alertTriangle}</span>
      <span class="callout__content new-session-page__alert-message"
        >${formatUiError(message)}</span
      >
      ${
        action
          ? html`<button
              class="btn btn--sm"
              type="button"
              ?disabled=${action.disabled}
              @click=${action.onClick}
            >
              ${action.label}
            </button>`
          : nothing
      }
    </div>
  `;
}

export function renderNewSessionBody(options: {
  error: string | null;
  errorAction?: Parameters<typeof renderDraftError>[1];
  pendingMessage: ReturnType<typeof buildLocalUserMessage>;
  userId?: string | null;
  submitting: boolean;
  statusLabel?: string;
  completion?: { label: string; onOpen?: () => void; disabled?: boolean };
  showDraft?: boolean;
  renderDraft: () => TemplateResult;
  onOpenImage: (item: ImageLightboxItem) => void;
}) {
  const { pendingMessage } = options;
  const normalized = pendingMessage ? normalizeMessage(pendingMessage) : null;
  const avatarPlacement = resolveChatDefaultAvatarPlacement(
    true,
    normalized?.sender ? options.userId : null,
  );
  const draftLocked = options.submitting && !pendingMessage;
  // Late cleanup can fail while a replacement submission is still pending.
  return html`
    <div class="sr-only" role="status" aria-live="polite">
      ${pendingMessage ? (options.completion?.label ?? options.statusLabel ?? t("newSession.starting")) : nothing}
    </div>
    <div
      class="new-session-page__scroll ${pendingMessage ? `chat-thread ${avatarPlacement === "footer" ? "chat-thread--direct" : ""}` : ""}"
      ?inert=${draftLocked}
      aria-busy=${String(options.submitting)}
      @mousedown=${beginNativeWindowDragFromTopInset}
    >
      ${options.error ? renderDraftError(options.error, options.errorAction) : nothing}
      ${
        pendingMessage && normalized
          ? renderNewSessionSubmission(
              pendingMessage,
              normalized,
              avatarPlacement,
              options.onOpenImage,
              options.statusLabel,
              options.completion,
            )
          : options.renderDraft()
      }
      ${pendingMessage && options.showDraft ? options.renderDraft() : nothing}
    </div>
  `;
}

function renderNewSessionSubmission(
  message: NonNullable<ReturnType<typeof buildLocalUserMessage>>,
  normalized: ReturnType<typeof normalizeMessage>,
  avatarPlacement: "footer" | "gutter",
  onOpenImage: (item: ImageLightboxItem) => void,
  statusLabel = t("newSession.starting"),
  completion?: { label: string; onOpen?: () => void; disabled?: boolean },
) {
  const key = "new-session-submission";
  const senderHue = normalized.sender ? resolveIdentityHue(normalized.sender) : null;
  const { images, attachments } = projectMessageMedia(message, normalized.content);
  const markdown = resolveMessageDisplayMarkdown(message, normalized);
  const json = parseMarkdownJson(markdown);
  const imageOptions = { onOpenImage };
  // Keep Markdown passive until Chat mounts its interaction owners. Uploaded
  // images have their own lightbox handler and remain interactive while pending.
  return html`<div class="new-session-page__starting chat-thread-inner">
    <div
      class="chat-group user ${normalized.sender ? "chat-group--with-footer" : ""} ${senderHue === null ? "" : "chat-group--sender-tint"}"
      style=${senderHue === null ? nothing : `--chat-sender-hue: ${senderHue}`}
      data-chat-row-key=${key}
    >
      ${
        normalized.sender && avatarPlacement === "gutter"
          ? renderUserAvatarSlot(
              resolveIdentityAvatarView(normalized.sender),
              formatSenderLabel(normalized.sender) ?? "",
            )
          : nothing
      }
      <div class="chat-group-messages">
        <div
          class="chat-bubble ${images.length ? "chat-bubble--with-images" : ""}"
          data-message-id=${key}
          data-message-text=${markdown || nothing}
        >
          ${renderMessageImages(images, imageOptions)}
          ${renderAssistantAttachments(attachments, imageOptions, undefined, undefined, false)}
          ${
            json
              ? renderMessageJson(
                  json,
                  key,
                  { role: "user", isStreaming: false },
                  { codeBlockChrome: "none" },
                )
              : markdown
                ? renderMessageMarkdown(
                    markdown,
                    key,
                    { role: "user", isStreaming: false },
                    { codeBlockChrome: "none" },
                  )
                : nothing
          }
        </div>
      </div>
      ${
        normalized.sender && avatarPlacement === "footer"
          ? html`<div class="chat-group-footer">
              <div class="chat-group-footer__meta">
                ${renderChatAuthorAvatar(normalized.sender)}
              </div>
            </div>`
          : nothing
      }
    </div>
    <div class="chat-group assistant chat-group--working">
      <div class="chat-group-messages">
        ${
          completion
            ? html`<div class="callout" role="status">
                <span class="callout__content">${completion.label}</span>
                ${
                  completion.onOpen
                    ? html`<button
                        class="btn btn--sm"
                        type="button"
                        ?disabled=${completion.disabled}
                        @click=${completion.onOpen}
                      >
                        ${t("sessionsView.openSession")}
                      </button>`
                    : nothing
                }
              </div>`
            : renderChatWorkingIndicator(
                { kind: "reading-indicator", key, startedAt: message.timestamp },
                { startupLabel: statusLabel },
              )
        }
      </div>
    </div>
  </div>`;
}
