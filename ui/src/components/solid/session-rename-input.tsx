import { onSettled } from "solid-js";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../lib/ime.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export function SessionRenameInput(props: {
  class?: string;
  renameValue: string;
  renameDisabledReason?: string;
  onRenameInput(value: string): void;
  onCommitRename(): void;
  onCancelRename(): void;
}) {
  let input!: HTMLInputElement;
  onSettled(() => {
    input.focus();
    input.select();
  });
  return (
    <input
      class={["chat-pane__session-title-input", props.class]}
      value={props.renameValue}
      aria-label={t("chat.sessionHeader.renameInputAria")}
      placeholder={t("chat.sessionHeader.renameInputPlaceholder")}
      onInput={(event) => props.onRenameInput(event.currentTarget.value)}
      onCompositionEnd={recordCompositionEnd}
      ref={[(element) => (input = element), nativeListener("keyup", clearCompositionEnd)]}
      onKeyDown={(event) => {
        if (isComposingKeyboardEvent(event)) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (!props.renameDisabledReason) {
            props.onCommitRename();
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          props.onCancelRename();
        }
      }}
      onBlur={(event) => {
        clearCompositionEnd(event);
        if (!props.renameDisabledReason) {
          props.onCommitRename();
        }
      }}
    />
  );
}
