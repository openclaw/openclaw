import { roleScopesAllow } from "../../../../src/shared/operator-scope-compat.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { patchSettings } from "../../app/settings.ts";
import {
  focusComposerInput,
  readComposerEditor,
  selectComposerInput,
} from "../../lib/composer-input.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { adjustTextareaHeight } from "./components/chat-composer-dom.ts";
import { ComposerDictationOwner } from "./composer-dictation.ts";
import { ComposerMicrophoneOwner } from "./composer-microphone-picker.ts";
import type { ComposerSnippetTarget } from "./composer-snippets.ts";

type DirectDictationTextarea = ReturnType<typeof createDirectDictationTextarea>;
type PlaceTranscript = ComposerDictationOwner["placeTranscript"];

/** Caret mutations stay synchronous so partial and late transcripts target one draft snapshot. */
export function createDirectDictationTextarea(read: () => HTMLTextAreaElement | null) {
  let capturedSelection: { start: number; end: number; value: string } | null = null;
  const owner = {
    /** Keep the pre-preview draft so partial dictation does not compound insertions. */
    captureSelection() {
      const textarea = read();
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
            maxLength: textarea.maxLength,
          })?.value
        : undefined;
    },
    /** Commit live keystrokes before the owning draft rerenders. */
    insertTranscript(
      place: PlaceTranscript,
      transcript: string,
      late?: true,
      preservePreview?: true,
      exact?: true,
    ): string | null {
      const target = read();
      // Delayed finals must not replace edits made after Stop unlocked this draft.
      const insertion =
        target &&
        place(
          transcript,
          capturedSelection,
          {
            start: late ? target.selectionStart : target.value.length,
            end: late ? target.selectionEnd : target.value.length,
            value: target.value,
            maxLength: target.maxLength,
          },
          late,
          preservePreview,
          exact,
        );
      if (
        !target ||
        !insertion ||
        (exact && target.maxLength >= 0 && insertion.value.length > target.maxLength)
      ) {
        return null;
      }
      capturedSelection = insertion.captured;
      if (!insertion.changed) {
        return null;
      }
      target.value = insertion.value;
      adjustTextareaHeight(target);
      if (exact) {
        selectComposerInput(target, insertion.caret, insertion.caret);
      } else {
        queueMicrotask(() => {
          if (target.isConnected) {
            focusComposerInput(target, { preventScroll: true });
            selectComposerInput(target, insertion.caret, insertion.caret);
          }
        });
      }
      return insertion.value;
    },
    captureSnippetTarget(
      place: PlaceTranscript,
      onMessage: (text: string) => void,
    ): ComposerSnippetTarget | undefined {
      const target = read();
      if (!target || target.disabled) {
        return undefined;
      }
      const selection = {
        value: target.value,
        start: target.selectionStart,
        end: target.selectionEnd,
      };
      const isCurrent = () =>
        target.isConnected &&
        read() === target &&
        target.value === selection.value &&
        !target.disabled;
      return {
        isCurrent,
        commit: (text) => {
          if (!isCurrent()) {
            return false;
          }
          const editor = readComposerEditor(target);
          if (editor) {
            const insertion = place(text, selection, selection, undefined, undefined, true);
            if (
              !insertion?.changed ||
              (target.maxLength >= 0 && insertion.value.length > target.maxLength)
            ) {
              return false;
            }
            editor.replace(
              insertion.value.slice(selection.start, insertion.caret),
              selection.start,
              selection.end,
              true,
            );
            return target.value === insertion.value ? target : false;
          }
          // A mention-capable surface may not have mounted the rich editor yet.
          const mentions = target.getAttribute("data-composer-mentions");
          if (mentions && mentions !== "[]") {
            return false;
          }
          capturedSelection = selection;
          const value = owner.insertTranscript(place, text, undefined, undefined, true);
          if (value === null) {
            return false;
          }
          onMessage(value);
          return target;
        },
      };
    },
  };
  return owner;
}

type DirectDictationOptions = {
  textarea: Pick<
    DirectDictationTextarea,
    "captureSelection" | "insertTranscript" | "previewTranscript"
  > &
    Partial<Pick<DirectDictationTextarea, "captureSnippetTarget">>;
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
  }

  get active(): boolean {
    return this.session?.active === true;
  }

  previewDraft(): string | undefined {
    return this.session?.active
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
      captureSnippetTarget: this.options.textarea.captureSnippetTarget
        ? () => {
            const target = this.options.textarea.captureSnippetTarget!(
              this.place,
              this.options.onMessage,
            );
            return target
              ? {
                  ...target,
                  isCurrent: () => ownsDraft() && this.options.canCommit() && target.isCurrent(),
                }
              : undefined;
          }
        : undefined,
      onCommit: (transcript: string, late?: true, preservePreview?: true) => {
        // Owner changes replace draft ownership. Object identity keeps even an
        // A -> B -> A transition from accepting the prior owner's snapshot.
        if (!ownsDraft() || !this.options.canCommit()) {
          return;
        }
        const next = this.options.textarea.insertTranscript(
          this.place,
          transcript,
          late,
          preservePreview,
        );
        if (next !== null) {
          this.options.onMessage(next);
        }
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
      onSubmit: () => {
        if (ownsDraft() && this.options.canCommit()) {
          this.options.onSubmit();
        }
      },
    };
  }
}
