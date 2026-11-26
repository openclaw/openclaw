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
  return {
    client: props.gatewayClient ?? null,
    sessionKey: props.sessionKey,
    draftKey: composerDraftKey(props),
    contextKey: JSON.stringify([props.dictationContextKey, props.currentSessionId]),
    corrections: props.composerCorrections ?? { mode: "off" as const, locale: "en-US" },
    getDraftRevision: () => state.editRevision,
    captureDraftGuard: props.captureDictationDraft ?? (() => () => false),
    connected: props.connected,
    enabled: props.composerHoldToRecord !== false && (props.canCompose ?? props.canSend),
    dictationAvailable: devicePicker.dictationStatus === "ready",
    realtimeTalkActive: props.realtimeTalkActive === true,
    onCommit: (transcript: string, late?: true, preservePreview?: true, ownedOnly?: true) => {
      const target = state.composerTextarea;
      const selection = state.dictationSelection;
      // Correction ranges own only this recording. Even a retained targetless
      // command cannot delete a selection that predates the recording.
      const captured = ownedOnly && selection ? { ...selection, start: selection.end } : selection;
      // A newer recording may be painting a partial over its captured draft.
      const liveValue = preservePreview
        ? (captured?.value ?? props.getDraft?.() ?? props.draft)
        : (target?.value ?? props.getDraft?.() ?? props.draft);
      const insertion = state.dictation?.placeTranscript(
        transcript,
        captured,
        {
          start: (ownedOnly ? target?.selectionEnd : target?.selectionStart) ?? liveValue.length,
          end: target?.selectionEnd ?? liveValue.length,
          value: liveValue,
        },
        late,
        preservePreview,
      );
      if (!insertion) {
        return;
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
