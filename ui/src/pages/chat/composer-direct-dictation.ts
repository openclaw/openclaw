import { roleScopesAllow } from "../../../../src/shared/operator-scope-compat.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { patchSettings } from "../../app/settings.ts";
import { focusComposerInput, selectComposerInput } from "../../lib/composer-input.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { adjustTextareaHeight } from "./components/chat-composer-dom.ts";
import { ComposerDictationOwner } from "./composer-dictation.ts";
import { ComposerMicrophoneOwner } from "./composer-microphone-picker.ts";
import type { DictationDraftSnapshot } from "./dictation-refinement.ts";

type DirectDictationTextarea = ReturnType<typeof createDirectDictationTextarea>;
type PlaceTranscript = ComposerDictationOwner["placeTranscript"];

/** Caret mutations stay synchronous so partial and late transcripts target one draft snapshot. */
export function createDirectDictationTextarea(read: () => HTMLTextAreaElement | null) {
  let capturedSelection: { start: number; end: number; value: string } | null = null;
  let revision = 0;
  let observed: HTMLTextAreaElement | null = null;
  // A comparison for programmatic changes; the textarea remains the draft authority.
  let observedValue: string | undefined;
  const subscribers = new Set<() => void>();
  const current = () => {
    const target = read();
    if (target !== observed) {
      observed = target;
      observedValue = target?.value;
      capturedSelection = null;
      revision += 1;
    } else if (target && target.value !== observedValue) {
      observedValue = target.value;
      revision += 1;
    }
    return target;
  };
  const readDraft = (): DictationDraftSnapshot | undefined => {
    const target = current();
    return target?.isConnected ? { revision, value: target.value } : undefined;
  };
  const invalidateDraft = () => {
    revision += 1;
    capturedSelection = null;
    observed = null;
    observedValue = undefined;
  };
  const apply = (target: HTMLTextAreaElement, insertion: { value: string; caret: number }) => {
    target.value = insertion.value;
    observedValue = target.value;
    revision += 1;
    const appliedRevision = revision;
    adjustTextareaHeight(target);
    queueMicrotask(() => {
      if (
        target.isConnected &&
        current() === target &&
        revision === appliedRevision &&
        target.value === insertion.value
      ) {
        focusComposerInput(target, { preventScroll: true });
        selectComposerInput(target, insertion.caret, insertion.caret);
      }
    });
  };
  return {
    readDraft,
    invalidateDraft,
    // The composer calls this after accepting the input, not from a competing DOM listener.
    recordInput() {
      observedValue = read()?.value;
      revision += 1;
      for (const subscriber of subscribers) {
        subscriber();
      }
    },
    subscribeDraft(listener: () => void) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    /** Keep the pre-preview draft so partial dictation does not compound insertions. */
    captureSelection() {
      const textarea = current();
      capturedSelection = textarea
        ? { start: textarea.selectionStart, end: textarea.selectionEnd, value: textarea.value }
        : null;
    },
    previewTranscript(place: PlaceTranscript, transcript: string): string | undefined {
      const textarea = current();
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
      enforceLimit?: true,
    ): string | null {
      const target = current();
      if (!target) {
        return null;
      }
      const captured = capturedSelection;
      const live = {
        start: late ? target.selectionStart : target.value.length,
        end: late ? target.selectionEnd : target.value.length,
        value: target.value,
        // Reviewed text must fit in full; ordinary dictation uses bounded placement.
        maxLength: enforceLimit ? -1 : target.maxLength,
      };
      // Delayed finals must not replace edits made after Stop unlocked this draft.
      const insertion = place(transcript, captured, live, late, preservePreview);
      if (!insertion) {
        return null;
      }
      if (enforceLimit && target.maxLength >= 0 && insertion.value.length > target.maxLength) {
        return null;
      }
      capturedSelection = insertion.captured;
      if (!insertion.changed) {
        return null;
      }
      apply(target, insertion);
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
    | "readDraft"
    | "invalidateDraft"
    | "subscribeDraft"
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
  private owner: {
    key: string;
    client: GatewayBrowserClient | null;
    auth: GatewayBrowserClient["auth"] | undefined;
  } | null = null;
  private readonly stopDraft: (() => void) | undefined;

  constructor(private readonly options: DirectDictationOptions) {
    super();
    // Forward the owned device picker's receipts through the dictation owner's projection.
    this.devicePicker.subscribe(this.changed);
    this.stopDraft = this.options.textarea.subscribeDraft?.(() => {
      if (this.session?.cleanupReview) {
        this.changed();
      }
    });
  }

  private readonly changed = () => this.dispatchEvent(new Event("change"));
  private readonly place: PlaceTranscript = (...args) => this.session?.placeTranscript(...args);

  subscribe(listener: () => void) {
    return listen(this, "change", listener);
  }

  dispose(): void {
    this.owner = null;
    this.options.textarea.invalidateDraft?.();
    this.stopDraft?.();
    this.session?.dispose();
    this.session = null;
    this.devicePicker.dispose();
  }

  get active(): boolean {
    return this.session?.active === true;
  }

  previewDraft(): string | undefined {
    return this.session?.active && !this.session.requiresCleanupReview
      ? this.options.textarea.previewTranscript(this.place, this.session.transcript)
      : undefined;
  }

  get dictation() {
    return this.session ?? undefined;
  }

  /** Sending retires the review before any async submission can reuse this draft. */
  dismissCleanup(): void {
    this.session?.dismissCleanup();
  }

  prepare(ownerKey: string, inputDeviceId?: string) {
    const client = this.options.getClient();
    const auth = client?.auth;
    if (this.owner?.key !== ownerKey || this.owner.client !== client || this.owner.auth !== auth) {
      this.owner = { key: ownerKey, client, auth };
      this.options.textarea.invalidateDraft?.();
      this.session?.dispose();
      this.session = null;
    }
    const owner = this.owner;
    const ownsDraft = () =>
      this.owner === owner && this.options.getClient() === client && client?.auth === auth;
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
      readDraft: () => (ownsDraft() ? this.options.textarea.readDraft?.() : undefined),
      onCommit: (transcript: string, late?: true, preservePreview?: true): false | void => {
        // Owner changes replace draft ownership. Object identity keeps even an
        // A -> B -> A transition from accepting the prior owner's snapshot.
        if (!ownsDraft() || !this.options.canCommit()) {
          return false;
        }
        const reviewing =
          this.session?.requiresCleanupReview || Boolean(this.session?.cleanupReview);
        const next = this.options.textarea.insertTranscript(
          this.place,
          transcript,
          late,
          preservePreview,
          reviewing ? true : undefined,
        );
        if (next === null) {
          return reviewing ? false : undefined;
        }
        this.options.onMessage(next);
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
        if (ownsDraft() && this.options.canCommit() && !dictation.finishingCleanup) {
          this.dismissCleanup();
          this.options.onSubmit();
        }
      },
    };
  }
}
