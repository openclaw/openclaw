import { roleScopesAllow } from "../../../../src/shared/operator-scope-compat.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { patchSettings } from "../../app/settings.ts";
import {
  canReplaceComposerInputWithHistory,
  composerInputHasFocus,
  focusComposerInput,
  replaceComposerInputWithHistory,
  selectComposerInput,
} from "../../lib/composer-input.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { adjustTextareaHeight } from "./components/chat-composer-dom.ts";
import {
  placeReviewedDictation,
  type DictationFormattingTarget,
  type ReviewedDictationPlacement,
} from "./composer-dictation-formatting.ts";
import { ComposerDictationOwner } from "./composer-dictation.ts";
import { ComposerMicrophoneOwner } from "./composer-microphone-picker.ts";

type DirectDictationTextarea = ReturnType<typeof createDirectDictationTextarea>;
type PlaceTranscript = ComposerDictationOwner["placeTranscript"];

/** Caret mutations stay synchronous so partial and late transcripts target one draft snapshot. */
export function createDirectDictationTextarea(read: () => HTMLTextAreaElement | null) {
  let capturedSelection: { start: number; end: number; value: string } | null = null;
  let observed: HTMLTextAreaElement | null = null;
  let revision = 0;
  let stopObserving: (() => void) | undefined;
  const observe = () => {
    const target = read();
    if (target !== observed) {
      stopObserving?.();
      observed = target;
      revision++;
      stopObserving = target ? listen(target, "input", () => revision++) : undefined;
    }
    return target;
  };
  return {
    dispose() {
      stopObserving?.();
      stopObserving = undefined;
      observed = null;
      capturedSelection = null;
      revision++;
    },
    focus() {
      focusComposerInput(read(), { preventScroll: true });
    },
    readFormattingTarget(): DictationFormattingTarget | undefined {
      const target = observe();
      if (!target) {
        return undefined;
      }
      const root = target.closest("form, .new-session-page__draft");
      const active = target.ownerDocument.activeElement;
      return {
        identity: target,
        revision,
        value: target.value,
        start: target.selectionStart,
        end: target.selectionEnd,
        editable: target.isConnected && !target.disabled && !target.readOnly,
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
          version: 1,
          revision: 1,
          // Side chat and New Session render submitted messages as Markdown.
          formats: canReplaceComposerInputWithHistory(target)
            ? ["text/plain", "text/markdown"]
            : [],
          markdownProfile: "commonmark-0.31.2-lists",
          safeMultiline: true,
          ...(target.maxLength >= 0 ? { maxLength: target.maxLength } : {}),
        },
      };
    },
    /** Keep the pre-preview draft so partial dictation does not compound insertions. */
    captureSelection() {
      const textarea = observe();
      capturedSelection = textarea
        ? { start: textarea.selectionStart, end: textarea.selectionEnd, value: textarea.value }
        : null;
    },
    previewTranscript(place: PlaceTranscript, transcript: string): string | undefined {
      const textarea = read();
      return textarea
        ? place(transcript, capturedSelection, {
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
            value: textarea.value,
          })?.value
        : undefined;
    },
    /** Commit live keystrokes before the owning draft rerenders. */
    insertTranscript(
      place: PlaceTranscript,
      transcript: string,
      late?: true,
      preservePreview?: true,
      reviewed?: ReviewedDictationPlacement,
    ): string | null {
      const target = read();
      // Delayed finals must not replace edits made after Stop unlocked this draft.
      const insertion =
        target &&
        (reviewed
          ? { ...placeReviewedDictation(transcript, reviewed), changed: true }
          : place(
              transcript,
              capturedSelection,
              {
                start: late ? target.selectionStart : target.value.length,
                end: late ? target.selectionEnd : target.value.length,
                value: target.value,
              },
              late,
              preservePreview,
            ));
      if (!target || !insertion) {
        return null;
      }
      capturedSelection = insertion.captured;
      if (!insertion.changed) {
        return null;
      }
      if (reviewed) {
        const receipt = replaceComposerInputWithHistory(
          target,
          insertion.value,
          () => reviewed.isCurrent?.() === true,
          reviewed.target,
        );
        if (receipt === false) {
          return null;
        }
        if (receipt !== true) {
          throw new Error("Reviewed insertion outcome is unknown");
        }
      } else {
        target.value = insertion.value;
      }
      adjustTextareaHeight(target);
      queueMicrotask(() => {
        if (target.isConnected) {
          focusComposerInput(target, { preventScroll: true });
          selectComposerInput(target, insertion.caret, insertion.caret);
        }
      });
      return insertion.value;
    },
  };
}

type DirectDictationOptions = {
  textarea: Pick<
    DirectDictationTextarea,
    | "captureSelection"
    | "insertTranscript"
    | "previewTranscript"
    | "readFormattingTarget"
    | "focus"
    | "dispose"
  >;
  getClient: () => GatewayBrowserClient | null;
  prepareSession?: () => Promise<string | undefined>;
  getSessionKey?: () => string | undefined;
  isConnected: () => boolean;
  canCommit: () => boolean;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  onSubmit: () => void;
};

/**
 * Dictation for composers without a Talk capability (New Session, Side chat).
 * Their microphone enters the shared dictation session directly on click.
 */
export class DirectDictationControl extends EventTarget {
  private readonly devicePicker = new ComposerMicrophoneOwner();
  private session: ComposerDictationOwner | null = null;
  private owner: { key: string } | null = null;

  constructor(private readonly options: DirectDictationOptions) {
    super();
    // Forward the owned device picker's receipts through the dictation owner's projection.
    this.devicePicker.subscribe(this.changed);
  }

  private readonly changed = () => this.dispatchEvent(new Event("change"));
  private readonly place: PlaceTranscript = (...args) => this.session?.placeTranscript(...args);

  subscribe(listener: () => void) {
    return listen(this, "change", listener);
  }

  dispose(): void {
    this.owner = null;
    this.session?.dispose();
    this.session = null;
    this.devicePicker.dispose();
    this.options.textarea.dispose?.();
  }

  get active(): boolean {
    return this.session?.active === true;
  }

  get locksDraft(): boolean {
    return this.session?.locksComposer === true;
  }

  previewDraft(): string | undefined {
    return this.session?.active && !this.session.requiresFormattingReview
      ? this.options.textarea.previewTranscript(this.place, this.session.transcript)
      : undefined;
  }

  get dictation() {
    return this.session ?? undefined;
  }

  prepare(ownerKey: string, inputDeviceId?: string) {
    if (this.owner?.key !== ownerKey) {
      this.owner = { key: ownerKey };
      this.session?.dispose();
      this.session = null;
    }
    const owner = this.owner;
    const ownsDraft = () => this.owner === owner;
    const client = this.options.getClient();
    const connected = this.options.isConnected() && client !== null;
    this.devicePicker.syncCatalog(client, connected, this.options.getSessionKey?.());
    const enabled = this.options.canCommit();
    const dictationOptions = {
      client,
      connected,
      enabled,
      prepareSession:
        client?.auth &&
        !roleScopesAllow({
          role: client.auth.role ?? "operator",
          requestedScopes: ["operator.talk"],
          allowedScopes: client.auth.scopes ?? [],
        })
          ? this.options.prepareSession
          : undefined,
      dictationAvailable: this.devicePicker.dictationStatus === "ready",
      realtimeTalkActive: false,
      readFormattingTarget: () => this.options.textarea.readFormattingTarget?.(),
      onFormattingDismiss: () => this.options.textarea.focus?.(),
      onCommit: (
        transcript: string,
        late?: true,
        preservePreview?: true,
        reviewed?: ReviewedDictationPlacement,
      ) => {
        // Owner changes replace draft ownership. Object identity keeps even an
        // A -> B -> A transition from accepting the prior owner's snapshot.
        if (!ownsDraft() || !this.options.canCommit()) {
          return false;
        }
        const next = this.options.textarea.insertTranscript(
          this.place,
          transcript,
          late,
          preservePreview,
          reviewed,
        );
        if (next !== null) {
          this.options.onMessage(next);
        }
        return next !== null;
      },
      onError: (message: string) => {
        if (ownsDraft()) {
          this.options.onError(message);
        }
      },
      onDictationUnavailable: this.devicePicker.handleOpen,
    };
    if (!this.session) {
      this.session = new ComposerDictationOwner(dictationOptions);
      // Forward the owned recording session's receipts without copying its mutable state.
      this.session.subscribe(this.changed);
    }
    this.session.update(dictationOptions);
    const dictation = this.session;

    return {
      voice: {
        connected,
        disabled: !enabled,
        readDictation: () => dictation,
        microphonePicker: {
          devices: this.devicePicker.devices,
          loading: this.devicePicker.loading,
          open: this.devicePicker.open,
          selectedDeviceId: inputDeviceId?.trim() ?? "",
          voiceActive: false,
          issue: this.devicePicker.issue,
          showRealtimeCapability: false,
          realtimeStatus: this.devicePicker.realtimeStatus,
          dictationStatus: this.devicePicker.dictationStatus,
          onOpen: this.devicePicker.handleOpen,
          onClose: this.devicePicker.handleClose,
          onSelect: (deviceId: string) => {
            patchSettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined });
            this.devicePicker.handleClose();
          },
        },
        onDirectDictationStart: () => this.options.textarea.captureSelection(),
      },
      onReleaseFocus: (source: ComposerDictationOwner) => {
        if (!ownsDraft() || source !== this.session || !this.options.canCommit()) {
          return;
        }
        const target = this.options.textarea.readFormattingTarget?.();
        if (target?.editable && target.focused) {
          this.options.textarea.focus?.();
        }
      },
      onSubmit: () => {
        if (ownsDraft() && this.options.canCommit()) {
          this.options.onSubmit();
        }
      },
    };
  }
}
