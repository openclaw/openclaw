import { Portal, render } from "@solidjs/web";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../i18n/index.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../../lib/ime.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../../lib/keyboard-shortcut-contract.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import {
  isChatSelectionPopupElement,
  mountChatSelectionPopup,
  positionChatSelectionPopup,
  removeChatSelectionPopup,
} from "./chat-selection-popup.tsx";

export function showChatAnnotationEditor(options: {
  paneId: string;
  anchorRect: DOMRect;
  anchorElement?: HTMLElement;
  sourceRange?: Range;
  comment: string;
  expanded?: boolean;
  readSignal?: AbortSignal;
  onSave: (comment: string) => boolean | void;
  onDelete?: () => void;
  onCancel?: () => void;
}) {
  if (options.readSignal?.aborted) {
    return undefined;
  }
  removeChatSelectionPopup();
  let popup!: HTMLDivElement;
  let input!: HTMLTextAreaElement;
  let confirm!: HTMLButtonElement;
  let remove!: HTMLButtonElement;
  let cancelButton!: HTMLButtonElement;
  let saveButton!: HTMLButtonElement;
  const cancel = () => {
    removeChatSelectionPopup();
    options.onCancel?.();
  };
  const save = () => {
    if (options.readSignal?.aborted) {
      removeChatSelectionPopup();
      return;
    }
    if (options.onSave(input.value) !== false) {
      removeChatSelectionPopup();
    }
  };
  const resizeInput = () => {
    const scrollTop = input.scrollTop;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    input.scrollTop = scrollTop;
    positionChatSelectionPopup(
      popup,
      options.anchorElement?.getBoundingClientRect() ?? options.anchorRect,
    );
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.target === input &&
      !isComposingKeyboardEvent(event) &&
      (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.sendMessage, event) ||
        matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.modifiedEnter, event))
    ) {
      event.preventDefault();
      save();
    }
    if (event.key === "Tab") {
      const focusable = [input, confirm, remove, cancelButton, saveButton].filter(
        (element) => element.getClientRects().length > 0,
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  const dispose = render(
    () => (
      <Portal mount={document.body}>
        <div
          ref={(element) => {
            popup = element;
          }}
          class={[
            "chat-annotation-editor",
            { "chat-annotation-editor--expanded": options.expanded },
          ]}
          role="dialog"
          aria-label={t("chat.messages.annotationEditor")}
          onKeyDown={onKeyDown}
        >
          <textarea
            ref={(element) => {
              input = element;
            }}
            value={options.comment}
            rows={1}
            placeholder={t("chat.messages.annotationComment")}
            aria-label={t("chat.messages.annotationComment")}
            onInput={resizeInput}
            onCompositionEnd={recordCompositionEnd}
            onKeyUp={clearCompositionEnd}
            onBlur={clearCompositionEnd}
          />
          <button
            ref={(element) => {
              confirm = element;
            }}
            type="button"
            class="btn primary chat-annotation-editor__confirm"
            aria-label={t("chat.messages.saveAnnotation")}
            onClick={save}
          >
            <Icon name="cornerDownLeft" />
          </button>
          <div class="chat-annotation-editor__controls">
            <button
              ref={(element) => {
                remove = element;
              }}
              type="button"
              class="btn btn--icon btn--ghost chat-annotation-editor__delete"
              aria-label={t("chat.messages.deleteAnnotation")}
              title={t("chat.messages.deleteAnnotation")}
              onClick={() => {
                removeChatSelectionPopup();
                if (!options.readSignal?.aborted) {
                  (options.onDelete ?? options.onCancel)?.();
                }
              }}
            >
              <Icon name="trash" />
            </button>
            <button
              ref={(element) => {
                cancelButton = element;
              }}
              type="button"
              class="btn"
              aria-label={t("common.cancel")}
              onClick={cancel}
            >
              {t("common.cancel")}
            </button>
            <button
              ref={(element) => {
                saveButton = element;
              }}
              type="button"
              class="btn primary"
              aria-label={t("common.save")}
              onClick={save}
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      </Portal>
    ),
    document.createElement("div"),
  );
  // A width or height change repositions the editor and makes the transcript
  // follow its end by scrolling. That layout compensation must not discard a
  // comment the user is still writing, so an edited comment survives the
  // scroll; an untouched editor still closes, keeping its existing behavior.
  const originalComment = options.comment;
  const signal = mountChatSelectionPopup(
    popup,
    resizeInput,
    options.paneId,
    dispose,
    options.onCancel,
    () => input.value === originalComment,
  );
  if (options.sourceRange && typeof Highlight !== "undefined") {
    // Keep the passage visible as a selection after focus moves into the textarea.
    CSS.highlights.set("openclaw-comment", new Highlight(options.sourceRange));
    listen(signal, "abort", () => CSS.highlights.delete("openclaw-comment"), {
      once: true,
    });
  }
  const abort = () => removeChatSelectionPopup();
  if (options.readSignal) {
    const stopRead = listen(options.readSignal, "abort", abort, { once: true });
    listen(signal, "abort", stopRead, { once: true });
  }
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
  return () => {
    if (isChatSelectionPopupElement(popup)) {
      positionChatSelectionPopup(
        popup,
        options.anchorElement?.getBoundingClientRect() ?? options.anchorRect,
      );
    }
  };
}
