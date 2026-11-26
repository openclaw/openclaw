import { resolveDictationRefinementPreference } from "../../../app/settings-contract.ts";
import { loadSettings } from "../../../app/settings.ts";
import { t } from "../../../i18n/index.ts";
import {
  focusComposerInput,
  replaceComposerDraft,
  selectComposerInput,
} from "../../../lib/composer-input.ts";
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
  const refinement = resolveDictationRefinementPreference({
    saved: loadSettings().dictationRefinement,
  });
  return {
    client: props.gatewayClient ?? null,
    sessionKey: props.sessionKey,
    draftKey: composerDraftKey(props),
    connected: props.connected,
    enabled: props.composerHoldToRecord !== false,
    dictationAvailable: devicePicker.dictationStatus === "ready",
    realtimeTalkActive: props.realtimeTalkActive === true,
    ...(refinement ? { refinement: { policy: refinement } } : {}),
    readRefinementTarget: () => {
      const target = state.composerTextarea;
      const value = props.getDraft?.() ?? props.draft;
      if (!target || (state.dictationSelection && state.dictationSelection.value !== value)) {
        return undefined;
      }
      // The DOM may show provisional captions. The draft owner retains the
      // authoritative pre-preview value and increments editRevision on input.
      return {
        target,
        revision: state.editRevision,
        value,
        start: state.dictationSelection?.start ?? target.selectionStart,
        end: state.dictationSelection?.end ?? target.selectionEnd,
      };
    },
    onCommit: (
      transcript: string,
      late?: true,
      preservePreview?: true,
      reviewed?: { isCurrent: () => boolean },
    ) => {
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
      );
      if (!insertion) {
        return false;
      }
      if (
        reviewed &&
        (!target ||
          target.readOnly ||
          target.disabled ||
          !reviewed.isCurrent() ||
          (captured && captured.value !== (props.getDraft?.() ?? props.draft)))
      ) {
        return false;
      }
      // A final reviewed insertion is one history transaction. Restore the
      // owned pre-preview baseline before creating its undo step.
      if (reviewed && target && captured) {
        target.value = captured.value;
      }
      const transaction =
        reviewed && target
          ? replaceComposerDraft(target, insertion.value, reviewed.isCurrent)
          : undefined;
      if (transaction && !transaction.committed) {
        return transaction;
      }
      if (target) {
        if (!transaction) {
          target.value = insertion.value;
        }
        adjustTextareaHeight(target);
      }
      commitComposerDraft(props, insertion.value);
      state.dictationSelection = insertion.captured;
      queueMicrotask(() => {
        const textarea = state.composerTextarea;
        if (!textarea || (transaction && (!transaction.canUndo() || textarea !== target))) {
          return;
        }
        focusComposerInput(textarea, { preventScroll: true });
        selectComposerInput(textarea, insertion.caret, insertion.caret);
      });
      return transaction ?? insertion.changed;
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
