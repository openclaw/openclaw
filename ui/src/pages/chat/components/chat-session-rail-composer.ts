import { html } from "lit";
import { ref } from "lit/directives/ref.js";
import type { ChatSendShortcut } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
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

export function createSessionRailComposer(options: {
  submit: () => void;
  onDraftChange: (draft: string) => void;
  sendShortcut: () => ChatSendShortcut;
}) {
  let textarea: HTMLTextAreaElement | null = null;
  const bindTextarea = (element?: Element) => {
    const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
    if (textarea && textarea !== nextTextarea) {
      disconnectTextareaOverflowObserver(textarea);
    }
    textarea = nextTextarea;
    if (nextTextarea) {
      observeTextareaOverflow(nextTextarea);
      scheduleTextareaHeightAdjustment(nextTextarea);
    }
  };
  return {
    ref: bindTextarea,
    dispose() {
      bindTextarea();
    },
    syncDraft(draft: string) {
      if (textarea?.isConnected && textarea.value !== draft) {
        scheduleTextareaHeightAdjustment(textarea);
      }
    },
    handleKeydown: (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      const sendShortcutMatches =
        options.sendShortcut() === "enter" || event.metaKey || event.ctrlKey;
      if (event.key === "Enter" && !event.shiftKey && sendShortcutMatches) {
        event.preventDefault();
        if (!event.repeat) {
          options.submit();
        }
      }
    },
    handleInput: (event: InputEvent) => {
      const target = event.currentTarget;
      if (target instanceof HTMLTextAreaElement) {
        adjustTextareaHeight(target);
        options.onDraftChange(target.value);
      }
    },
  };
}

export function renderSessionRailComposer(options: {
  companion: ChatSessionCompanionThread;
  connected: boolean;
  pending: boolean;
  sendShortcut: ChatSendShortcut;
  composer: ReturnType<typeof createSessionRailComposer>;
  attachmentProps: ChatAttachmentControlsProps;
  submit: () => void;
}) {
  const { companion, connected, pending, sendShortcut, composer, attachmentProps, submit } =
    options;
  const placeholder = t("chat.rail.askPlaceholder");
  return html`
    <form
      class="agent-chat__input chat-session-rail__composer"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        submit();
      }}
    >
      ${renderAttachmentPreview(attachmentProps)}
      ${renderAttachmentReadStatus(attachmentProps.attachmentReads?.pendingReads ?? 0)}
      <div class="agent-chat__composer-input-row">
        <label class="agent-chat__composer-combobox chat-session-rail__prompt">
          <textarea
            class="chat-session-rail__input"
            rows="1"
            maxlength="400"
            autocomplete="off"
            aria-label=${t("chat.rail.askLabel")}
            aria-keyshortcuts=${sendShortcut === "enter" ? "Enter" : "Control+Enter Meta+Enter"}
            .value=${companion.draft}
            placeholder=${placeholder}
            ?disabled=${!connected}
            @paste=${(event: ClipboardEvent) => {
              if (connected) {
                handleChatAttachmentPaste(event, attachmentProps, { imagesOnly: true });
                if (event.defaultPrevented) {
                  event.stopPropagation();
                }
              }
            }}
            @keydown=${composer.handleKeydown}
            @input=${composer.handleInput}
            ${ref(composer.ref)}
          ></textarea>
          <span class="agent-chat__composer-placeholder" aria-hidden="true">${placeholder}</span>
        </label>
      </div>
      <div class="agent-chat__composer-footer">
        <div class="agent-chat__composer-trail">
          <div class="agent-chat__composer-actions">
            <button
              class="chat-send-btn"
              type="submit"
              aria-label=${t("chat.rail.askSubmit")}
              ?disabled=${!connected || pending || Boolean(attachmentProps.attachmentReads?.pendingReads) || (!companion.draft.trim() && !companion.attachments?.length)}
            >
              ${icons.arrowUp}
            </button>
          </div>
        </div>
      </div>
    </form>
  `;
}
