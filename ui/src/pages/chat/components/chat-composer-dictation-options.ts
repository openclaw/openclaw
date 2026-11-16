import { t } from "../../../i18n/index.ts";
import { focusComposerInput, selectComposerInput } from "../../../lib/composer-input.ts";
import { insertComposerDictation } from "../composer-dictation.ts";
import type { ComposerMicrophoneOwner } from "../composer-microphone-picker.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { commitComposerDraft, composerDraftKey } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function createComposerDictationOptions(
  props: ChatComposerProps,
  state: ChatComposerState,
  devicePicker: ComposerMicrophoneOwner,
  setError: (error: string | null) => void,
  onTap?: () => void,
) {
  return {
    client: props.gatewayClient ?? null,
    sessionKey: props.sessionKey,
    draftKey: composerDraftKey(props),
    connected: props.connected,
    enabled: props.composerHoldToRecord !== false,
    dictationAvailable: devicePicker.dictationStatus === "ready",
    realtimeTalkActive: props.realtimeTalkActive === true,
    onCommit: (transcript: string, late?: true, preservePreview?: true) => {
      const target = state.composerTextarea;
      const captured = state.dictationSelection;
      // A newer recording may be painting a partial over its captured draft.
      const liveValue = preservePreview
        ? (captured?.value ?? props.getDraft?.() ?? props.draft)
        : (target?.value ?? props.getDraft?.() ?? props.draft);
      // Stop unlocks the draft. Preserve later edits by using the live caret only
      // when a delayed final finds that the captured draft has changed.
      const selection =
        captured && (preservePreview || !late || captured.value === liveValue)
          ? captured
          : {
              start: target?.selectionStart ?? liveValue.length,
              end: target?.selectionEnd ?? liveValue.length,
              value: liveValue,
            };
      const insertion = insertComposerDictation(
        selection.value,
        transcript,
        selection.start,
        selection.end,
      );
      if (target) {
        target.value = insertion.value;
        adjustTextareaHeight(target);
      }
      commitComposerDraft(props, insertion.value);
      state.dictationSelection = preservePreview
        ? { start: insertion.caret, end: insertion.caret, value: insertion.value }
        : null;
      queueMicrotask(() => {
        const textarea = state.composerTextarea;
        if (!textarea) {
          return;
        }
        focusComposerInput(textarea, { preventScroll: true });
        selectComposerInput(textarea, insertion.caret, insertion.caret);
      });
    },
    onError: (
      message: string,
      failure: { kind: "interrupted" | "start" | "busy"; preservesText: boolean },
    ) => {
      if (failure.kind === "busy") {
        setError(message);
        return;
      }
      const recovery =
        failure.kind === "interrupted" && failure.preservesText
          ? t("chat.composer.dictationInterruptedRecovery")
          : t("chat.composer.dictationStartRecovery");
      setError(`${message} ${recovery}`);
    },
    onDictationUnavailable: devicePicker.handleOpen,
    onTap,
  };
}
