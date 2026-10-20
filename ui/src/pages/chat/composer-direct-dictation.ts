import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { patchSettings } from "../../app/settings.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { adjustTextareaHeight } from "./components/chat-composer-dom.ts";
import { ComposerDictationOwner, insertComposerDictation } from "./composer-dictation.ts";
import { ComposerMicrophoneOwner } from "./composer-microphone-picker.ts";

export type DirectDictationTextarea = ReturnType<typeof createDirectDictationTextarea>;

/** Caret mutations stay synchronous so partial and late transcripts target one draft snapshot. */
export function createDirectDictationTextarea(read: () => HTMLTextAreaElement | null) {
  let capturedSelection: { start: number; end: number; value: string } | null = null;
  return {
    /** Keep the pre-preview draft so partial dictation does not compound insertions. */
    captureSelection() {
      const textarea = read();
      capturedSelection = textarea
        ? { start: textarea.selectionStart, end: textarea.selectionEnd, value: textarea.value }
        : null;
    },
    previewTranscript(transcript: string): string | undefined {
      const textarea = read();
      if (!textarea) {
        return undefined;
      }
      const selection = capturedSelection ?? {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        value: textarea.value,
      };
      return insertComposerDictation(selection.value, transcript, selection.start, selection.end)
        .value;
    },
    /** Commit live keystrokes before the owning draft rerenders. */
    insertTranscript(transcript: string, late?: true): string | null {
      const target = read();
      if (!target) {
        return null;
      }
      // Delayed finals must not replace edits made after Stop unlocked this draft.
      const selection =
        capturedSelection && (!late || capturedSelection.value === target.value)
          ? capturedSelection
          : {
              start: late ? target.selectionStart : target.value.length,
              end: late ? target.selectionEnd : target.value.length,
              value: target.value,
            };
      capturedSelection = null;
      const insertion = insertComposerDictation(
        selection.value,
        transcript,
        selection.start,
        selection.end,
      );
      if (insertion.value === selection.value) {
        return null;
      }
      target.value = insertion.value;
      adjustTextareaHeight(target);
      queueMicrotask(() => {
        if (target.isConnected) {
          target.focus({ preventScroll: true });
          target.selectionStart = insertion.caret;
          target.selectionEnd = insertion.caret;
        }
      });
      return insertion.value;
    },
  };
}

type DirectDictationOptions = {
  textarea: Pick<
    DirectDictationTextarea,
    "captureSelection" | "insertTranscript" | "previewTranscript"
  >;
  getClient: () => GatewayBrowserClient | null;
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
      ? this.options.textarea.previewTranscript(this.session.transcript)
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
    this.devicePicker.syncCatalog(client, connected);
    const enabled = this.options.canCommit();
    const dictationOptions = {
      client,
      connected,
      enabled,
      dictationAvailable: this.devicePicker.dictationStatus === "ready",
      realtimeTalkActive: false,
      onCommit: (transcript: string, late?: true) => {
        // Owner changes replace draft ownership. Object identity keeps even an
        // A -> B -> A transition from accepting the prior owner's snapshot.
        if (!ownsDraft() || !this.options.canCommit()) {
          return;
        }
        const next = this.options.textarea.insertTranscript(transcript, late);
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
