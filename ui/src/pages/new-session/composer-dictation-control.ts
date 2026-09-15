import { html } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import {
  renderComposerDictationSendAction,
  renderComposerDictationStatus,
  renderComposerVoiceButton,
  renderMicrophonePicker,
} from "../chat/components/chat-composer-controls.ts";
import { ComposerDictationController } from "../chat/composer-dictation.ts";
import { ComposerMicrophonePicker } from "../chat/composer-microphone-picker.ts";
import type { NewSessionComposerTextareaController } from "./composer.ts";

registerNewSessionSetupEnglish();

type NewSessionDictationOptions = {
  textarea: NewSessionComposerTextareaController;
  getClient: () => GatewayBrowserClient | null;
  isConnected: () => boolean;
  canCommit: () => boolean;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  onSubmit: () => void;
  requestUpdate: () => void;
};

/**
 * Dictation for the new-session draft. This surface has no Talk capability, so
 * its microphone enters the shared dictation session directly on click.
 */
export class NewSessionDictationControl {
  private readonly devicePicker: ComposerMicrophonePicker;
  private dictation: ComposerDictationController | null = null;
  private owner: { key: string } | null = null;
  private preparation: { client: GatewayBrowserClient | null; abort: AbortController } | null =
    null;

  constructor(private readonly options: NewSessionDictationOptions) {
    this.devicePicker = new ComposerMicrophonePicker(options.requestUpdate);
  }

  dispose(): void {
    this.owner = null;
    this.preparation?.abort.abort();
    this.preparation = null;
    this.dictation?.dispose();
    this.dictation = null;
    this.devicePicker.dispose();
  }

  get active(): boolean {
    return this.dictation?.active === true;
  }

  previewDraft(): string | undefined {
    const dictation = this.dictation;
    return dictation?.active
      ? this.options.textarea.previewTranscript(dictation.transcript)
      : undefined;
  }

  renderStatus() {
    if (this.preparation) {
      return html`<div class="agent-chat__composer-status" role="status">
        <span class="btn__spinner" aria-hidden="true"></span>${t("common.loading")}
      </div>`;
    }
    return renderComposerDictationStatus(this.dictation ?? undefined);
  }

  render(ownerKey: string, inputDeviceId?: string) {
    if (this.owner?.key !== ownerKey) {
      this.owner = { key: ownerKey };
      this.preparation?.abort.abort();
      this.preparation = null;
      this.dictation?.dispose();
      this.dictation = null;
    }
    const owner = this.owner;
    const ownsDraft = () => this.owner === owner;
    const client = this.options.getClient();
    const connected = this.options.isConnected() && client !== null;
    if (
      this.preparation &&
      (!connected || this.preparation.client !== client || !this.options.canCommit())
    ) {
      this.preparation.abort.abort();
    }
    // A text draft must not activate unrelated speech-provider discovery.
    this.devicePicker.syncCatalog(client, connected, false);
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
        this.options.requestUpdate();
      },
      onError: (message: string) => {
        if (ownsDraft()) {
          this.options.onError(message);
        }
      },
      onStateChange: () => {
        if (ownsDraft()) {
          this.options.requestUpdate();
        }
      },
      onDictationUnavailable: this.devicePicker.handleOpen,
    };
    this.dictation ??= new ComposerDictationController(dictationOptions);
    this.dictation.update(dictationOptions);
    const dictation = this.dictation;

    return html`
      ${renderComposerVoiceButton({
        connected,
        sending: false,
        isBusy: !enabled || this.preparation !== null,
        dictation,
        idleLabel: t("newSession.dictate"),
        microphonePicker: renderMicrophonePicker({
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
        }),
        onDirectDictationStart: () => {
          if (!owner || this.preparation || !ownsDraft() || !this.options.canCommit()) {
            return;
          }
          this.options.textarea.captureSelection();
          const abort = new window.AbortController();
          this.preparation = { client, abort };
          const cancel = () => abort.abort();
          abort.signal.addEventListener(
            "abort",
            () => {
              if (this.preparation?.abort === abort) {
                this.preparation = null;
                this.options.requestUpdate();
              }
            },
            { once: true },
          );
          window.addEventListener("blur", cancel, { signal: abort.signal });
          document.addEventListener(
            "visibilitychange",
            () => {
              if (document.hidden) {
                cancel();
              }
            },
            { signal: abort.signal },
          );
          document.addEventListener(
            "keydown",
            (event) => {
              if (event.key === "Escape") {
                cancel();
              }
            },
            { signal: abort.signal },
          );
          this.options.requestUpdate();
          void this.devicePicker
            .prepareDictation()
            .then((ready) => {
              if (
                abort.signal.aborted ||
                ready === null ||
                !ownsDraft() ||
                this.dictation !== dictation ||
                this.options.getClient() !== client ||
                !this.options.isConnected() ||
                !this.options.canCommit()
              ) {
                return;
              }
              if (!ready) {
                this.devicePicker.handleOpen();
                return;
              }
              dictation.update({ ...dictationOptions, dictationAvailable: true });
              dictation.startDirect();
            })
            .catch((error: unknown) => {
              if (!abort.signal.aborted && ownsDraft()) {
                this.options.onError(error instanceof Error ? error.message : String(error));
              }
            })
            .finally(cancel);
        },
      })}
      ${renderComposerDictationSendAction(dictation, () => {
        if (ownsDraft() && this.options.canCommit()) {
          this.options.onSubmit();
        }
      })}
    `;
  }
}
