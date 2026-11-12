import { onSettled, useContext } from "solid-js";
import { isMobileBrowserPlatform } from "../../lib/browser-platform.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  composerInputHasFocus,
  focusComposerInput,
  syncComposerInput,
} from "../../lib/composer-input.ts";
import { clearCompositionEnd, recordCompositionEnd } from "../../lib/ime.ts";
import { createMentionComposerBinding } from "../../lib/reactive/composer-editor.ts";
import type { connectedElementRef } from "../../lib/reactive/element-ref.ts";
import { liveValue as createLiveValue } from "../../lib/reactive/live-value.ts";
import { handleChatAttachmentPaste } from "../chat/components/chat-attachments.ts";
import {
  adjustTextareaHeight,
  handleTextareaOverflowInteraction,
  handleTextareaOverflowScroll,
} from "../chat/components/chat-composer-dom.ts";
import { NewSessionComposerTextareaContext } from "./composer-textarea-context.ts";
import type { NewSessionComposerFrame, NewSessionComposerOptions } from "./composer.tsx";

/** The draft-keyed field owns its editor/history; same-draft updates retain both. */
export function NewSessionComposerInput(props: {
  options: NewSessionComposerOptions;
  frame: NewSessionComposerFrame;
  placeholder: string;
  input: ReturnType<typeof connectedElementRef<HTMLTextAreaElement>>;
}) {
  const textarea = useContext(NewSessionComposerTextareaContext);
  const messageValue = createLiveValue(() => props.frame.visibleMessage, syncComposerInput);
  const editorRef = createMentionComposerBinding(
    () => props.options.getMentions?.() ?? props.options.mentions ?? [],
    textarea.mentionMenu.selectedAvatarUrls,
  );
  let field: HTMLTextAreaElement | undefined;
  let releaseInput: (() => void) | undefined;
  let restoreFocus = false;
  onSettled(() => {
    textarea.ref(field);
    if (restoreFocus && document.activeElement === document.body) {
      focusComposerInput(field, { preventScroll: true });
    }
    return () => {
      if (textarea.getTextarea() === field) {
        textarea.ref();
      }
      releaseInput?.();
    };
  });
  return (
    <textarea
      data-composer-mentions={JSON.stringify(props.options.mentions ?? [])}
      ref={[
        (element) => {
          restoreFocus = composerInputHasFocus(props.input.read());
          releaseInput = props.input.bind(element);
          field = element;
          messageValue(element);
        },
        editorRef,
      ]}
      class="new-session-page__message"
      rows="1"
      autofocus={globalThis.matchMedia?.("(max-width: 560px)")?.matches ?? false}
      disabled={props.options.submitting || props.options.messageLocked}
      readonly={props.options.dictationActive}
      placeholder={props.placeholder}
      aria-label={props.frame.messagePlaceholder}
      enterkeyhint="enter"
      aria-keyshortcuts={isMobileBrowserPlatform() ? undefined : props.frame.keyShortcuts}
      aria-autocomplete="list"
      aria-controls={props.frame.menuVisible ? props.frame.menuListboxId : undefined}
      aria-haspopup={props.frame.menuVisible ? "listbox" : undefined}
      aria-activedescendant={props.frame.activeMenuOptionId ?? undefined}
      aria-describedby={props.frame.menuAnnouncementId}
      onInput={(event) => {
        handleTextareaOverflowInteraction(event);
        if (props.options.dictationActive) {
          return;
        }
        const target = event.currentTarget;
        adjustTextareaHeight(target, { nativeInput: true });
        const mentions = props.frame.mentionMenuHost.getMentions();
        const nextMentions = updateHumanMentions(
          props.options.message,
          target.value,
          mentions,
          textarea.mentionInput,
        );
        props.options.onInput(
          target.value,
          mentions.length || nextMentions.length ? nextMentions : undefined,
        );
        textarea.mentionInput = undefined;
        props.frame.updateMenus(target, event);
      }}
      onBeforeInput={(event) => {
        handleTextareaOverflowInteraction(event);
        const target = event.currentTarget;
        textarea.mentionInput = {
          value: target.value,
          start: target.selectionStart,
          end: target.selectionEnd,
          inputType: event.inputType,
        };
        textarea.emojiMenu.complete(
          event,
          !props.frame.composerLocked && !props.options.nativeTerminal && !textarea.composing,
        );
      }}
      onScroll={handleTextareaOverflowScroll}
      onWheel={handleTextareaOverflowInteraction}
      onPointerDown={handleTextareaOverflowInteraction}
      onSelect={(event) => props.frame.handleSelect(event)}
      onFocus={(event) => props.frame.handleSelect(event)}
      onPointerUp={(event) => props.frame.handleSelect(event)}
      onKeyUp={(event) => {
        clearCompositionEnd(event);
        textarea.emojiMenu.handleKeyup(event);
        if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
          props.frame.handleSelect(event);
        }
      }}
      onBlur={(event) => {
        handleTextareaOverflowInteraction(event);
        clearCompositionEnd(event);
        textarea.composing = false;
        textarea.emojiMenu.close();
      }}
      onCompositionEnd={(event) => {
        recordCompositionEnd(event);
        textarea.composing = false;
        props.frame.updateMenus(event.currentTarget);
      }}
      onKeyDown={(event) => {
        handleTextareaOverflowInteraction(event);
        props.frame.handleComposerKeydown(event);
      }}
      onCompositionStart={(event) => {
        handleTextareaOverflowInteraction(event);
        textarea.composing = true;
        textarea.emojiMenu.close();
        textarea.mentionMenu.close();
        props.options.onChange();
      }}
      onPaste={(event) => {
        if (props.options.nativeTerminal && event.clipboardData?.files.length) {
          event.preventDefault();
          props.options.onUnsupportedAttachment?.();
        } else if (!props.frame.composerLocked && !props.options.nativeTerminal) {
          handleChatAttachmentPaste(event, props.frame.attachmentProps);
        }
      }}
    />
  );
}
