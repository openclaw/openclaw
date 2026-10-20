import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ChatSendShortcut } from "../../../app/settings.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../../lib/ime.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { showToast } from "../../../lib/toast.ts";
import type { ChatSessionCompanionThread } from "../chat-session-companion.ts";
import {
  createDirectDictationTextarea,
  DirectDictationControl,
} from "../composer-direct-dictation.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { createChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
import { ChatAttachmentInputs } from "./chat-attachment-inputs.tsx";
import { handleChatAttachmentPaste } from "./chat-attachments.ts";
import { AttachmentPreview, AttachmentReadStatus } from "./chat-attachments.tsx";
import {
  adjustTextareaHeight,
  handleTextareaOverflowInteraction,
  handleTextareaOverflowScroll,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  paneDomId,
  scheduleTextareaHeightAdjustment,
} from "./chat-composer-dom.ts";
import { createComposerEmojiMenu, EmojiMenu } from "./chat-composer-emoji.tsx";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import { ChatModelControls, type ChatModelControlsProps } from "./chat-model-controls.tsx";
import { ComposerDictationStatus } from "./chat-voice-activity.tsx";
import { DirectDictationView } from "./direct-dictation-view.tsx";

const SIDE_CHAT_QUESTION_MAX_LENGTH = 400;

export function sessionRailQuestion(companion: ChatSessionCompanionThread): string {
  return (
    companion.draft.trim() ||
    (companion.attachments?.some((attachment) => attachment.mimeType.startsWith("image/"))
      ? t("chat.rail.askImageQuestion")
      : "")
  );
}

/**
 * Side chat questions use the main composer's affordances that apply to a
 * read-only companion: image attachments, emoji shortcodes, dictation, and the
 * model and effort pickers, which choose Side chat's own model per question.
 * Session-scoped controls (commands, permissions, Talk) stay with the main chat.
 */
export function SessionRailComposer(props: {
  sessionKey: string;
  companion: ChatSessionCompanionThread;
  modelControls?: ChatModelControlsProps;
  client: GatewayBrowserClient | null;
  connected: boolean;
  presented: boolean;
  pending: boolean;
  sendShortcut: ChatSendShortcut;
  inputDeviceId?: string;
  attachmentProps: ChatAttachmentControlsProps;
  submit: () => void;
  onDraftChange?: (draft: string) => void;
  textareaRef: (element: HTMLTextAreaElement) => void;
}) {
  let textarea: HTMLTextAreaElement | undefined;
  let composing = false;
  const paneId = () => `side-chat:${props.sessionKey}`;
  const emojiMenu = createComposerEmojiMenu();
  const inputHandle = createChatAttachmentInputHandle();
  const [plusMenuOpen, setPlusMenuOpen] = createSignal(false);
  const dictationControl = new DirectDictationControl({
    textarea: createDirectDictationTextarea(() => textarea ?? null),
    getClient: () => props.client,
    isConnected: () => props.connected,
    // Follow-ups stay editable while an answer is pending; submit owns that gate.
    canCommit: () => props.connected,
    onMessage: (message) => props.onDraftChange?.(message.slice(0, SIDE_CHAT_QUESTION_MAX_LENGTH)),
    onError: (message) => showToast({ message }),
    onSubmit: () => props.submit(),
  });
  const dictation = projectOwner(dictationControl, (owner) => owner);
  onCleanup(() => {
    emojiMenu.dispose();
    dictation.dispose();
    dictationControl.dispose();
    if (textarea) {
      disconnectTextareaOverflowObserver(textarea);
    }
  });
  const dictationActive = createMemo(() => dictation.read().active);
  // Dictation admission reads these inputs synchronously; a changed input re-prepares it.
  const dictationRevision = createMemo(() => ({
    revision: dictation.revision(),
    client: props.client,
    connected: props.connected,
  }));
  const visibleDraft = createMemo(() => {
    dictation.revision();
    return dictationControl.previewDraft() ?? props.companion.draft;
  });
  createEffect(visibleDraft, (draft) => {
    if (textarea && textarea.value !== draft) {
      textarea.value = draft;
      scheduleTextareaHeightAdjustment(textarea);
    }
  });
  // The dictated preview reaches the draft only on commit, so submission finishes it first.
  const submit = () => {
    const active = dictationControl.dictation;
    if (!active?.active) {
      props.submit();
      return;
    }
    if (active.finalizing) {
      return;
    }
    const sessionKey = props.sessionKey;
    void active.finishActive().then(() => {
      if (props.sessionKey === sessionKey) {
        props.submit();
      }
    });
  };
  const keydown = (event: KeyboardEvent) => {
    if (isComposingKeyboardEvent(event) || emojiMenu.handleKeydown(event, paneId())) {
      return;
    }
    const matches = props.sendShortcut === "enter" || event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && !event.shiftKey && matches) {
      event.preventDefault();
      if (!event.repeat) {
        submit();
      }
    }
  };
  return (
    <form
      class={[
        "agent-chat__input chat-session-rail__composer",
        { "agent-chat__input--dictating": dictationActive() },
      ]}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onOpenclaw-composer-dismiss-invocations={() => emojiMenu.dismiss(textarea ?? null)}
    >
      <EmojiMenu args={[emojiMenu, paneId(), textarea ?? null]} />
      <ChatAttachmentInputs
        {...props.attachmentProps}
        inputHandle={inputHandle}
        cameraActive={props.presented}
      />
      <AttachmentPreview {...props.attachmentProps} readRevision={props.attachmentProps} />
      <AttachmentReadStatus
        pendingReads={props.attachmentProps.attachmentReads?.pendingReads ?? 0}
      />
      <div class="agent-chat__composer-lede">
        <ComposerDictationStatus readDictation={() => dictation.read().dictation} />
      </div>
      <div class="agent-chat__composer-input-row">
        <label class="agent-chat__composer-combobox chat-session-rail__prompt">
          <textarea
            class="chat-session-rail__input"
            rows="1"
            maxlength={SIDE_CHAT_QUESTION_MAX_LENGTH}
            autocomplete="off"
            aria-label={t("chat.rail.askLabel")}
            aria-keyshortcuts={
              props.sendShortcut === "enter" ? "Enter" : "Control+Enter Meta+Enter"
            }
            aria-autocomplete="list"
            aria-controls={emojiMenu.open ? paneDomId(paneId(), "emoji-menu-listbox") : undefined}
            aria-activedescendant={emojiMenu.activeId(paneId()) ?? undefined}
            placeholder={t("chat.rail.askPlaceholder")}
            disabled={!props.connected}
            readonly={dictationActive()}
            onPaste={(event) => {
              if (props.connected) {
                handleChatAttachmentPaste(event, props.attachmentProps, { imagesOnly: true });
                if (event.defaultPrevented) {
                  event.stopPropagation();
                }
              }
            }}
            onKeyDown={(event) => {
              handleTextareaOverflowInteraction(event);
              keydown(event);
            }}
            onBeforeInput={(event) => {
              handleTextareaOverflowInteraction(event);
              emojiMenu.complete(event, props.connected && !composing);
            }}
            onCompositionStart={(event) => {
              handleTextareaOverflowInteraction(event);
              composing = true;
              emojiMenu.close();
            }}
            onWheel={handleTextareaOverflowInteraction}
            onPointerDown={handleTextareaOverflowInteraction}
            onScroll={handleTextareaOverflowScroll}
            onCompositionEnd={(event) => {
              recordCompositionEnd(event);
              composing = false;
              emojiMenu.update(event.currentTarget);
            }}
            onKeyUp={(event) => {
              clearCompositionEnd(event);
              emojiMenu.handleKeyup(event);
            }}
            onBlur={(event) => {
              handleTextareaOverflowInteraction(event);
              clearCompositionEnd(event);
              composing = false;
              emojiMenu.close();
            }}
            onInput={(event) => {
              handleTextareaOverflowInteraction(event);
              if (dictationActive()) {
                return;
              }
              adjustTextareaHeight(event.currentTarget);
              props.onDraftChange?.(event.currentTarget.value);
              emojiMenu.update(event.currentTarget, !composing);
            }}
            ref={(element) => {
              textarea = element;
              props.textareaRef(element);
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
        <div class="agent-chat__composer-lead">
          <ChatComposerPlusMenu
            menu={{
              attachments: props.attachmentProps,
              inputHandle,
              disabled: !props.connected || dictationActive(),
              open: plusMenuOpen(),
              view: "root",
              toolOverrides: null,
              onOpenChange: setPlusMenuOpen,
              onViewChange: () => {},
            }}
          />
        </div>
        <div class="agent-chat__composer-trail">
          <Show when={props.modelControls}>
            {(controls) => (
              <div class="agent-chat__composer-controls">
                <div class="chat-composer-model-control">
                  <ChatModelControls {...controls()} />
                </div>
              </div>
            )}
          </Show>
          <div class="agent-chat__composer-actions">
            <DirectDictationView
              control={dictationControl}
              ownerKey={props.sessionKey}
              inputDeviceId={props.inputDeviceId}
              renderRevision={dictationRevision()}
            />
            <Show when={!dictationActive()}>
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
            </Show>
          </div>
        </div>
      </div>
    </form>
  );
}
