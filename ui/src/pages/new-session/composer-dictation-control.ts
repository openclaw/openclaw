import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { ComposerDictationOwner } from "../chat/composer-dictation.ts";
import { ComposerMicrophoneOwner } from "../chat/composer-microphone-picker.ts";
import type { NewSessionComposerTextarea } from "./composer-textarea.ts";

registerNewSessionSetupEnglish();

type NewSessionDictationOptions = {
  textarea: NewSessionComposerTextarea;
  getClient: () => GatewayBrowserClient | null;
  isConnected: () => boolean;
  canCommit: () => boolean;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  onSubmit: () => void;
};

/**
 * Dictation for the new-session draft. This surface has no Talk capability, so
 * its microphone enters the shared dictation session directly on click.
 */
export class NewSessionDictationControl extends EventTarget {
  private readonly devicePicker = new ComposerMicrophoneOwner();
  private session: ComposerDictationOwner | null = null;
  private owner: { key: string } | null = null;

  constructor(private readonly options: NewSessionDictationOptions) {
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
        // Route changes replace draft ownership. Object identity keeps even an
        // A -> B -> A transition from accepting the prior route's snapshot.
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
        idleLabel: t("newSession.dictate"),
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
