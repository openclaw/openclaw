import { roleScopesAllow } from "../../../../src/shared/operator-scope-compat.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { resolveDictationRefinementPreference } from "../../app/settings-contract.ts";
import { loadLiveUiPreferences, patchSettings } from "../../app/settings.ts";
import type { ComposerDraftTransaction } from "../../lib/composer-draft-transaction.ts";
import { focusComposerInput, selectComposerInput } from "../../lib/composer-input.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { adjustTextareaHeight } from "./components/chat-composer-dom.ts";
import type { ComposerReviewedCommit } from "./composer-dictation-refinement.ts";
import { ComposerDictationOwner } from "./composer-dictation.ts";
import { ComposerMicrophoneOwner } from "./composer-microphone-picker.ts";

type DirectDictationTextarea = ReturnType<typeof createDirectDictationTextarea>;
type PlaceTranscript = ComposerDictationOwner["placeTranscript"];

/** Caret mutations stay synchronous so partial and late transcripts target one draft snapshot. */
export function createDirectDictationTextarea(read: () => HTMLTextAreaElement | null) {
  let capturedSelection: { start: number; end: number; value: string } | null = null;
  let capturedTarget: HTMLTextAreaElement | null = null;
  let revision = 0;
  let previewValue: string | undefined;
  let removeInputListener: (() => void) | undefined;
  const draftValue = (target: HTMLTextAreaElement) =>
    capturedSelection && target === capturedTarget && target.value === previewValue
      ? capturedSelection.value
      : target.value;
  const insertReviewed = (reviewed: ComposerReviewedCommit, canWrite?: () => boolean) => {
    const receipt = reviewed(read, canWrite);
    if (receipt?.committed) {
      capturedSelection = null;
      previewValue = undefined;
      revision += 1;
    }
    return receipt;
  };
  return {
    insertReviewed,
    /** Keep the pre-preview draft so partial dictation does not compound insertions. */
    captureSelection() {
      const textarea = read();
      removeInputListener?.();
      removeInputListener = undefined;
      revision += 1;
      capturedTarget = textarea;
      previewValue = undefined;
      capturedSelection = textarea
        ? { start: textarea.selectionStart, end: textarea.selectionEnd, value: textarea.value }
        : null;
      if (textarea) {
        removeInputListener = listen(textarea, "input", () => {
          revision += 1;
          previewValue = undefined;
        });
      }
    },
    readTarget() {
      const target = read();
      const value = target ? draftValue(target) : undefined;
      const selectionCurrent =
        !capturedSelection || (target === capturedTarget && capturedSelection.value === value);
      return target && value !== undefined
        ? {
            target,
            revision,
            value,
            selectionCurrent,
            start: capturedSelection?.start ?? target.selectionStart,
            end: capturedSelection?.end ?? target.selectionEnd,
          }
        : undefined;
    },
    dispose() {
      removeInputListener?.();
      removeInputListener = undefined;
      capturedSelection = null;
      capturedTarget = null;
      previewValue = undefined;
      revision += 1;
    },
    previewTranscript(place: PlaceTranscript, transcript: string): string | undefined {
      const textarea = read();
      previewValue = textarea
        ? place(transcript, capturedSelection, {
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
            value: textarea.value,
            maxLength: textarea.maxLength,
          })?.value
        : undefined;
      return previewValue;
    },
    /** Commit live keystrokes before the owning draft rerenders. */
    insertTranscript(
      place: PlaceTranscript,
      transcript: string,
      late?: true,
      preservePreview?: true,
      reviewed?: ComposerReviewedCommit,
    ): string | ComposerDraftTransaction | null {
      if (reviewed) {
        return insertReviewed(reviewed);
      }
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
        );
      if (!target || !insertion) {
        return null;
      }
      capturedSelection = insertion.captured;
      if (!insertion.changed) {
        return null;
      }
      target.value = insertion.value;
      previewValue = undefined;
      revision += 1;
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
    "captureSelection" | "insertTranscript" | "previewTranscript"
  > &
    Partial<Pick<DirectDictationTextarea, "readTarget" | "insertReviewed" | "dispose">>;
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
    this.options.textarea.dispose?.();
    this.devicePicker.dispose();
  }

  get active(): boolean {
    return this.session?.active === true;
  }

  previewDraft(): string | undefined {
    return this.session?.active && !this.session.requiresReview
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
    const textarea = this.options.textarea;
    const refinement =
      textarea.readTarget && textarea.insertReviewed
        ? resolveDictationRefinementPreference({
            saved: loadLiveUiPreferences().dictationRefinement,
          })
        : undefined;
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
      ...(refinement ? { refinement: { policy: refinement } } : {}),
      readRefinementTarget: textarea.readTarget,
      getDraftRevision: () => textarea.readTarget?.()?.revision ?? 0,
      getDraftText: () => textarea.readTarget?.()?.value,
      draftKey: ownerKey,
      onCommit: (
        transcript: string,
        late?: true,
        preservePreview?: true,
        reviewed?: ComposerReviewedCommit,
      ) => {
        // Owner changes replace draft ownership. Object identity keeps even an
        // A -> B -> A transition from accepting the prior owner's snapshot.
        if (!ownsDraft() || !this.options.canCommit()) {
          return false;
        }
        const next = reviewed
          ? (textarea.insertReviewed?.(reviewed, () => ownsDraft() && this.options.canCommit()) ??
              null)
          : textarea.insertTranscript(this.place, transcript, late, preservePreview);
        if (next !== null) {
          if (typeof next === "string") {
            this.options.onMessage(next);
            return true;
          }
          // A reviewed transaction publishes native input. Do not write its plain-text value
          // to the owner a second time, dropping mention metadata or recording another edit.
          return next;
        }
        return false;
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
        if (ownsDraft() && this.options.canCommit() && !dictation.pendingReview) {
          this.options.onSubmit();
        }
      },
    };
  }
}
