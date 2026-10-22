import { createMemo } from "solid-js";
import { isMobileBrowserPlatform } from "../../../lib/browser-platform.ts";
import { clearCompositionEnd } from "../../../lib/ime.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { liveValue } from "../../../lib/reactive/live-value.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { insertComposerDictation } from "../composer-dictation.ts";
import { handleChatAttachmentPaste } from "./chat-attachments.ts";
import {
  handleTextareaOverflowInteraction,
  handleTextareaOverflowScroll,
} from "./chat-composer-dom.ts";
import type { createChatComposerContext } from "./chat-composer-frame.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export type ComposerTextareaProps = {
  scopeKey: string;
  announcementId: string;
  disabledReasonId: string;
  placeholder: string;
};

export function renderComposerTextarea(
  context: () => ReturnType<typeof createChatComposerContext>,
  composer: ChatComposerProps,
  ownerState: ChatComposerState,
  view: ComposerTextareaProps,
) {
  let element: HTMLTextAreaElement | undefined;
  const value = createMemo(() => {
    const state = context().state;
    const draft = context().visibleDraft;
    const dictation = context().dictation;
    return dictation?.active
      ? insertComposerDictation(
          state.dictationSelection?.value ?? draft,
          dictation.transcript,
          state.dictationSelection?.start ?? draft.length,
          state.dictationSelection?.end ?? draft.length,
        ).value
      : draft;
  });
  const valueRef = liveValue(() => {
    const next = value();
    // The native IME preview owns the field until composition commits.
    return ownerState.composerComposing && element ? element.value : next;
  });
  const textareaRef = elementRef<HTMLTextAreaElement>((node) => {
    element = node;
    valueRef(node);
    ownerState.textareaRef?.(node);
    return () => {
      if (ownerState.composerTextarea === node) {
        ownerState.composerComposing = false;
        ownerState.textareaRef?.();
      }
    };
  });
  return (
    <textarea
      ref={[textareaRef]}

      dir={detectTextDirection(value())}
      disabled={!context().canCompose}
      readonly={context().dictation?.locksComposer === true || context().goalComposer.pending}
      aria-autocomplete="list"
      aria-controls={context().menus.menuVisible ? context().menus.menuListboxId : undefined}
      aria-haspopup={context().menus.menuVisible ? "listbox" : undefined}
      aria-activedescendant={context().menus.activeMenuOptionId ?? undefined}
      aria-describedby={`${view.announcementId}${
        composer.disabledReason ? ` ${view.disabledReasonId}` : ""
      }`}
      enterkeyhint="enter"
      aria-keyshortcuts={
        isMobileBrowserPlatform()
          ? undefined
          : context().sendShortcut === "enter"
            ? "Enter"
            : "Control+Enter Meta+Enter"
      }
      onKeyDown={(event) => {
        handleTextareaOverflowInteraction(event);
        context().handleKeyDown(event);
      }}
      onBeforeInput={(event) => {
        handleTextareaOverflowInteraction(event);
        context().handleBeforeInput(event);
      }}
      onInput={(event) => {
        handleTextareaOverflowInteraction(event);
        context().handleInput(event);
      }}
      onWheel={handleTextareaOverflowInteraction}
      onPointerDown={handleTextareaOverflowInteraction}
      onScroll={handleTextareaOverflowScroll}
      onSelect={(event) => context().handleSelect(event)}
      onFocus={(event) => context().handleSelect(event)}
      onPointerUp={(event) => context().handleSelect(event)}
      onKeyUp={(event: KeyboardEvent) => {
        clearCompositionEnd(event);
        context().state.emojiMenu.handleKeyup(event);
        if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
          context().handleSelect(event);
        }
      }}
      onCompositionStart={(event) => {
        handleTextareaOverflowInteraction(event);
        if (
          event.target !== context().state.composerTextarea ||
          context().draftKey !== view.scopeKey
        ) {
          return;
        }
        context().dismissPrediction();
        context().state.mentionMenu.close();
        context().state.emojiMenu.close();
        context().state.editRevision += 1;
        context().state.composerComposing = true;
        context().interaction.setComposition({
          key: context().draftKey,
          // SAFETY: The identity check above requires this scope's composer textarea.
          value: (event.target as HTMLTextAreaElement).value,
        });
      }}
      onCompositionEnd={(event) => context().handleCompositionEnd(event)}
      onBlur={(event) => {
        handleTextareaOverflowInteraction(event);
        context().handleBlur(event);
      }}
      onPaste={(event: ClipboardEvent) => {
        if (context().canCompose && !composer.suggestionComposer) {
          handleChatAttachmentPaste(event, composer);
        }
      }}
      aria-label={t("chat.composer.composerInput")}
      placeholder={context().dictation?.active ? "" : view.placeholder}
      rows="1"
    />
  );
}
