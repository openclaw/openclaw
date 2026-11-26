import {
  canReplaceComposerInputWithHistory,
  composerInputHasFocus,
} from "../../lib/composer-input.ts";
import type {
  ComposerDictationOwnerOptions,
  DictationFormattingCapture,
  DictationFormattingTarget,
} from "./composer-dictation-formatting.ts";

/** A latched mic can keep recording while its captured insertion authority expires. */
export function formattingTargetChanged(
  capture: DictationFormattingCapture | undefined,
  readTarget: ComposerDictationOwnerOptions["readFormattingTarget"],
  connecting: boolean,
  event?: Event,
): boolean {
  if (event?.type === "visibilitychange") {
    return document.visibilityState === "hidden";
  }
  if (event?.type === "blur") {
    return !connecting;
  }
  return Boolean(
    !(event?.type === "focusin" && connecting) &&
    capture &&
    !capture.invalidated &&
    !sameDictationFormattingTarget(capture.target, readTarget?.()),
  );
}

export function sameDictationFormattingTarget(
  captured: DictationFormattingTarget | undefined,
  live: DictationFormattingTarget | undefined,
): boolean {
  return Boolean(
    captured &&
    live &&
    captured.identity === live.identity &&
    captured.revision === live.revision &&
    captured.value === live.value &&
    captured.start === live.start &&
    captured.end === live.end &&
    captured.start >= 0 &&
    captured.start <= captured.end &&
    captured.end <= captured.value.length &&
    captured.capabilities.version === 1 &&
    live.capabilities.version === 1 &&
    captured.capabilities.revision === live.capabilities.revision &&
    captured.capabilities.safeMultiline === live.capabilities.safeMultiline &&
    captured.capabilities.maxLength === live.capabilities.maxLength &&
    captured.capabilities.markdownProfile === live.capabilities.markdownProfile &&
    captured.capabilities.richTextProfile === live.capabilities.richTextProfile &&
    captured.capabilities.formats.join(",") === live.capabilities.formats.join(",") &&
    captured.editable &&
    captured.focused &&
    live.editable &&
    live.focused,
  );
}

/** Read built-in target facts before the lazy capture boundary. */
export function readComposerDictationTarget(
  target: HTMLTextAreaElement,
  revision: number,
  value: string,
  enabled: boolean,
  root: string,
): DictationFormattingTarget {
  const doc = target.ownerDocument;
  const active = doc.activeElement;
  return {
    identity: target,
    revision,
    value,
    start: target.selectionStart,
    end: target.selectionEnd,
    editable: enabled && target.isConnected && !target.disabled && !target.readOnly,
    focused:
      doc.visibilityState !== "hidden" &&
      doc.hasFocus() &&
      Boolean(
        target.closest(root)?.contains(active) &&
        (composerInputHasFocus(target) ||
          active?.closest(
            ".dictation-formatting, .chat-send-btn--voice, .chat-send-btn--dictating, .chat-send-btn--dictation-commit",
          )),
      ),
    capabilities: {
      version: 1,
      revision: 1,
      formats: canReplaceComposerInputWithHistory(target) ? ["text/plain", "text/markdown"] : [],
      markdownProfile: "commonmark-0.31.2-lists",
      safeMultiline: true,
      ...(target.maxLength >= 0 ? { maxLength: target.maxLength } : {}),
    },
  };
}
