import { t } from "../../../i18n/index.ts";
import { focusComposerInput, selectComposerInput } from "../../../lib/composer-input.ts";
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
  const onCommit = (transcript: string, late?: true, preservePreview?: true, exact?: true) => {
    const target = state.composerTextarea;
    const captured = state.dictationSelection;
    // A newer recording may be painting a partial over its captured draft.
    const liveValue = preservePreview
      ? (captured?.value ?? props.getDraft?.() ?? props.draft)
      : (target?.value ?? props.getDraft?.() ?? props.draft);
    const insertion = state.dictation?.placeTranscript(
      transcript,
      captured,
      {
        start: target?.selectionStart ?? liveValue.length,
        end: target?.selectionEnd ?? liveValue.length,
        value: liveValue,
      },
      late,
      preservePreview,
      exact,
    );
    if (
      !insertion ||
      (exact && target && target.maxLength >= 0 && insertion.value.length > target.maxLength)
    ) {
      return false;
    }
    if (target) {
      target.value = insertion.value;
      adjustTextareaHeight(target);
    }
    commitComposerDraft(props, insertion.value);
    state.dictationSelection = insertion.captured;
    queueMicrotask(() => {
      const textarea = state.composerTextarea;
      if (!textarea) {
        return;
      }
      focusComposerInput(textarea, { preventScroll: true });
      selectComposerInput(textarea, insertion.caret, insertion.caret);
    });
    return true;
  };
  return {
    client: props.gatewayClient ?? null,
    sessionKey: props.sessionKey,
    draftKey: composerDraftKey(props),
    connected: props.connected,
    enabled: props.composerHoldToRecord !== false,
    dictationAvailable: devicePicker.dictationStatus === "ready",
    realtimeTalkActive: props.realtimeTalkActive === true,
    onCommit,
    captureSnippetTarget: () => {
      const target = state.composerTextarea;
      if (!target || target.disabled) {
        return undefined;
      }
      const key = composerDraftKey(props);
      const selection = {
        value: target.value,
        start: target.selectionStart,
        end: target.selectionEnd,
      };
      const isCurrent = () =>
        target.isConnected &&
        state.composerTextarea === target &&
        composerDraftKey(props) === key &&
        (props.getDraft?.() ?? props.draft) === selection.value &&
        target.value === selection.value &&
        !target.disabled;
      return {
        isCurrent,
        commit: (text: string) => {
          if (!isCurrent()) {
            return false;
          }
          state.dictationSelection = selection;
          return onCommit(text, undefined, undefined, true);
        },
      };
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
