import { t } from "../../../i18n/index.ts";
import { focusComposerInput, selectComposerInput } from "../../../lib/composer-input.ts";
import type { ReviewedDictationEdit } from "../composer-dictation-formatting.ts";
import { readComposerDictationTarget } from "../composer-dictation-target.ts";
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
    readFormattingTarget: () => {
      const target = state.composerTextarea;
      if (!target) {
        return undefined;
      }
      return readComposerDictationTarget(
        target,
        state.editRevision,
        props.getDraft?.() ?? props.draft,
        props.canSend && !props.submitDisabledReason && !state.composerComposing,
        ".agent-chat__composer-shell",
      );
    },
    onFormattingDismiss: () => focusComposerInput(state.composerTextarea, { preventScroll: true }),
    onCommit: (
      transcript: string,
      late?: true,
      preservePreview?: true,
      reviewed?: ReviewedDictationEdit,
    ) => {
      const target = state.composerTextarea;
      const captured = state.dictationSelection;
      // A newer recording may be painting a partial over its captured draft.
      const liveValue = preservePreview
        ? (captured?.value ?? props.getDraft?.() ?? props.draft)
        : (target?.value ?? props.getDraft?.() ?? props.draft);
      const insertion = reviewed
        ? reviewed.insertion
        : state.dictation?.placeTranscript(
            transcript,
            captured,
            {
              start: target?.selectionStart ?? liveValue.length,
              end: target?.selectionEnd ?? liveValue.length,
              value: liveValue,
            },
            late,
            preservePreview,
          );
      if (!insertion) {
        return false;
      }
      if (target) {
        if (reviewed) {
          // Apply the reviewed replacement as one existing editor history transaction.
          const receipt = reviewed.applyTo(target);
          if (receipt !== true) {
            return receipt;
          }
        } else {
          target.value = insertion.value;
        }
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
