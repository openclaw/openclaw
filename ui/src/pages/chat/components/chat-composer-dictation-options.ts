import { t } from "../../../i18n/index.ts";
import { focusComposerInput, selectComposerInput } from "../../../lib/composer-input.ts";
import type { ComposerMicrophoneOwner } from "../composer-microphone-picker.ts";
import type { DictationDraftReceipt } from "../dictation-refinement.ts";
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
    readDraft: () => ({
      revision: state.editRevision,
      value: props.getDraft?.() ?? props.draft,
    }),
    onCommit: (
      transcript: string,
      late?: true,
      preservePreview?: true,
    ): DictationDraftReceipt | false => {
      const target = state.composerTextarea;
      const captured = state.dictationSelection;
      const scope = state.composerDraftScope;
      // A newer recording may be painting a partial over its captured draft.
      const liveValue = preservePreview
        ? (captured?.value ?? props.getDraft?.() ?? props.draft)
        : (target?.value ?? props.getDraft?.() ?? props.draft);
      const liveSelection = {
        start: target?.selectionStart ?? liveValue.length,
        end: target?.selectionEnd ?? liveValue.length,
        value: liveValue,
      };
      const place = (text: string) =>
        state.dictation?.placeTranscript(text, captured, liveSelection, late, preservePreview);
      const insertion = place(transcript);
      if (!insertion) {
        return false;
      }
      const apply = (next: NonNullable<typeof insertion>) => {
        if (target) {
          target.value = next.value;
          adjustTextareaHeight(target);
        }
        commitComposerDraft(props, next.value);
        state.dictationSelection = next.captured;
        const revision = state.editRevision;
        queueMicrotask(() => {
          if (!target || state.composerTextarea !== target || state.editRevision !== revision) {
            return;
          }
          focusComposerInput(target, { preventScroll: true });
          selectComposerInput(target, next.caret, next.caret);
        });
      };
      apply(insertion);
      const revision = state.editRevision;
      let restored = false;
      const isCurrent = () =>
        !restored &&
        state.composerDraftScope === scope &&
        state.composerTextarea === target &&
        state.editRevision === revision &&
        (props.getDraft?.() ?? props.draft) === insertion.value &&
        (!target || target.value === insertion.value);
      return {
        isCurrent,
        restore: (text: string) => {
          if (!isCurrent()) {
            return false;
          }
          const original = place(text);
          if (!original) {
            return false;
          }
          restored = true;
          apply(original);
          return true;
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
