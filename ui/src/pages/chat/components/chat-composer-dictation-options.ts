import { t } from "../../../i18n/index.ts";
import {
  canReplaceComposerInputWithHistory,
  composerInputHasFocus,
  focusComposerInput,
  replaceComposerInputWithHistory,
  selectComposerInput,
} from "../../../lib/composer-input.ts";
import {
  placeReviewedDictation,
  type ReviewedDictationPlacement,
} from "../composer-dictation-formatting.ts";
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
      const root = target.closest(".agent-chat__composer-shell");
      const active = target.ownerDocument.activeElement;
      return {
        identity: target,
        revision: state.editRevision,
        value: props.getDraft?.() ?? props.draft,
        start: target.selectionStart,
        end: target.selectionEnd,
        editable:
          target.isConnected &&
          props.canSend &&
          !props.submitDisabledReason &&
          !target.disabled &&
          !target.readOnly &&
          !state.composerComposing,
        focused:
          target.ownerDocument.visibilityState !== "hidden" &&
          target.ownerDocument.hasFocus() &&
          Boolean(root?.contains(active)) &&
          (composerInputHasFocus(target) ||
            Boolean(
              active?.closest(
                ".dictation-formatting, .chat-send-btn--voice, .chat-send-btn--dictating, .chat-send-btn--dictation-commit",
              ),
            )),
        capabilities: {
          version: 1 as const,
          revision: 1,
          // The built-in composer accepts Markdown source; it never consumes HTML.
          formats: canReplaceComposerInputWithHistory(target)
            ? (["text/plain", "text/markdown"] as const)
            : [],
          markdownProfile: "commonmark-0.31.2-lists" as const,
          safeMultiline: true,
          ...(target.maxLength >= 0 ? { maxLength: target.maxLength } : {}),
        },
      };
    },
    onFormattingDismiss: () => focusComposerInput(state.composerTextarea, { preventScroll: true }),
    onCommit: (
      transcript: string,
      late?: true,
      preservePreview?: true,
      reviewed?: ReviewedDictationPlacement,
    ) => {
      const target = state.composerTextarea;
      const captured = state.dictationSelection;
      // A newer recording may be painting a partial over its captured draft.
      const liveValue = preservePreview
        ? (captured?.value ?? props.getDraft?.() ?? props.draft)
        : (target?.value ?? props.getDraft?.() ?? props.draft);
      const insertion = reviewed
        ? placeReviewedDictation(transcript, reviewed)
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
          const receipt = replaceComposerInputWithHistory(
            target,
            insertion.value,
            () => reviewed.isCurrent?.() === true,
            reviewed.target,
          );
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
