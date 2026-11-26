import { patchSettings } from "../../../app/settings.ts";
import { focusComposerInput } from "../../../lib/composer-input.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

/** Presentation bindings preserve capture admission at the existing dictation owner. */
export function createComposerCorrectionBindings(
  props: Pick<ChatComposerProps, "composerCorrections" | "onComposerCorrectionsChange">,
  state: Pick<ChatComposerState, "composerTextarea">,
  dictation: ComposerDictationOwner,
  options: Parameters<ComposerDictationOwner["update"]>[0],
) {
  return {
    correctionReview: dictation.correctionReview,
    resolveCorrection: (choice: "original" | "correction" | "cancel") => {
      const resolved = dictation.resolveCorrection(choice);
      if (resolved && state.composerTextarea) {
        focusComposerInput(state.composerTextarea, { preventScroll: true });
      }
      return resolved;
    },
    correctionControls: {
      policy: props.composerCorrections?.mode ?? ("off" as const),
      literal: dictation.literal,
      disabled: dictation.locksComposer,
      onPolicyChange: (mode: "off" | "explicit") => {
        // Invalidate pending plans synchronously before the preference projection updates.
        dictation.update({ ...options, corrections: { mode, locale: "en-US" } });
        if (props.onComposerCorrectionsChange) {
          props.onComposerCorrectionsChange(mode);
        } else {
          patchSettings({
            composerCorrections:
              mode === "explicit" ? { version: 1, mode, locale: "en-US" } : undefined,
          });
        }
      },
      onLiteralChange: (literal: boolean) => dictation.setLiteral(literal),
    },
  };
}
