import { createEffect, onCleanup } from "solid-js";
import type { ChatSendShortcut } from "../../../app/settings.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../../lib/ime.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import type { ChatSessionCompanionThread } from "../chat-session-companion.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import {
  handleChatAttachmentPaste,
  renderAttachmentPreview,
  renderAttachmentReadStatus,
} from "./chat-attachments.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  scheduleTextareaHeightAdjustment,
} from "./chat-composer-dom.ts";

export function sessionRailQuestion(companion: ChatSessionCompanionThread): string {
  return (
    companion.draft.trim() ||
    (companion.attachments?.some((attachment) => attachment.mimeType.startsWith("image/"))
      ? t("chat.rail.askImageQuestion")
      : "")
  );
}

export function SessionRailComposer(props: {
  companion: ChatSessionCompanionThread;
  connected: boolean;
  pending: boolean;
  sendShortcut: ChatSendShortcut;
  attachmentProps: ChatAttachmentControlsProps;
  submit: () => void;
  onDraftChange?: (draft: string) => void;
}) {
  let textarea!: HTMLTextAreaElement;
  createEffect(
    () => props.companion.draft,
    (draft) => {
      if (textarea.value !== draft) {
        textarea.value = draft;
        scheduleTextareaHeightAdjustment(textarea);
      }
    },
  );
  onCleanup(() => disconnectTextareaOverflowObserver(textarea));
  const keydown = (event: KeyboardEvent) => {
    if (isComposingKeyboardEvent(event)) {
      return;
    }
    const matches = props.sendShortcut === "enter" || event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && !event.shiftKey && matches) {
      event.preventDefault();
      if (!event.repeat) {
        props.submit();
      }
    }
  };
  return (
    <form
      class="agent-chat__input chat-session-rail__composer"
      onSubmit={(event) => {
        event.preventDefault();
        props.submit();
      }}
    >
      <LitContent value={renderAttachmentPreview(props.attachmentProps)} />
      <LitContent
        value={renderAttachmentReadStatus(props.attachmentProps.attachmentReads?.pendingReads ?? 0)}
      />
      <div class="agent-chat__composer-input-row">
        <label class="agent-chat__composer-combobox chat-session-rail__prompt">
          <textarea
            class="chat-session-rail__input"
            rows="1"
            maxlength="400"
            autocomplete="off"
            aria-label={t("chat.rail.askLabel")}
            aria-keyshortcuts={
              props.sendShortcut === "enter" ? "Enter" : "Control+Enter Meta+Enter"
            }
            placeholder={t("chat.rail.askPlaceholder")}
            disabled={!props.connected}
            onPaste={(event) => {
              if (props.connected) {
                handleChatAttachmentPaste(event, props.attachmentProps, { imagesOnly: true });
                if (event.defaultPrevented) {
                  event.stopPropagation();
                }
              }
            }}
            onKeyDown={keydown}
            onCompositionEnd={recordCompositionEnd}
            onKeyUp={clearCompositionEnd}
            onBlur={clearCompositionEnd}
            onInput={(event) => {
              adjustTextareaHeight(event.currentTarget);
              props.onDraftChange?.(event.currentTarget.value);
            }}
            ref={(element) => {
              textarea = element;
              observeTextareaOverflow(element);
              scheduleTextareaHeightAdjustment(element);
            }}
          />
          <span class="agent-chat__composer-placeholder" aria-hidden="true">
            {t("chat.rail.askPlaceholder")}
          </span>
        </label>
      </div>
      <div class="agent-chat__composer-footer">
        <div class="agent-chat__composer-trail">
          <div class="agent-chat__composer-actions">
            <button
              class="chat-send-btn"
              type="submit"
              aria-label={t("chat.rail.askSubmit")}
              disabled={
                !props.connected ||
                props.pending ||
                Boolean(props.attachmentProps.attachmentReads?.pendingReads) ||
                !sessionRailQuestion(props.companion)
              }
            >
              <Icon name="arrowUp" />
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
