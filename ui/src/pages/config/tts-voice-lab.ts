import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import "../../components/modal-dialog.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerTtsVoiceLabEnglish } from "../../i18n/locales/en-tts-voice-lab.ts";
import { bytesToBase64 } from "../../lib/bytes-base64.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { COMMUNICATION_SETTINGS_TARGET_IDS } from "./settings-targets.ts";
import {
  TtsClipRecorder,
  TtsClipRecorderCancelledError,
  TTS_CLIP_MAX_DURATION_MS,
  type TtsRecordedClip,
} from "./tts-clip-recorder.ts";
import {
  isGoogleVoiceStoreInternal,
  isGoogleVoiceStoreUncertain,
  isStoredSpeechVoice,
  shouldAcceptMicStart,
  shouldClearCreateErrorOnClose,
  storedVoiceCreatedSince,
  storedVoiceIds,
  voiceLabSubmitBlock,
  type StoredSpeechVoice,
} from "./tts-voice-lab-state.ts";

registerTtsVoiceLabEnglish();

const GOOGLE_PROVIDER = "google";

type VoicesGatewayResult =
  | StoredSpeechVoice[]
  | {
      voices?: StoredSpeechVoice[];
    };

type ReplicateGatewayResult = {
  id?: string;
  name?: string;
  mimeType?: string;
  audioBase64?: string;
};

type ClipSlot = "consent" | "source";

function clipObjectUrl(clip: TtsRecordedClip | null): string | null {
  if (!clip) {
    return null;
  }
  return URL.createObjectURL(new Blob([clip.wav], { type: clip.mimeType }));
}

class TtsVoiceLabSettings extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @property({ type: Boolean }) mutationDisabled = false;
  @property({ attribute: false }) editor: TemplateResult | typeof nothing = nothing;
  @property({ type: Boolean }) advancedExpanded = false;
  @state() private dialogOpen = false;
  @state() private displayName = "";
  @state() private consent: TtsRecordedClip | null = null;
  @state() private source: TtsRecordedClip | null = null;
  @state() private recording: ClipSlot | null = null;
  @state() private pending: ClipSlot | null = null;
  @state() private elapsedMs = 0;
  @state() private level = 0;
  @state() private createError: string | null = null;
  @state() private creating = false;
  @state() private storeUncertain = false;
  @state() private storedPreview: ReplicateGatewayResult | null = null;
  private readonly recorder = new TtsClipRecorder();
  private elapsedTimer: ReturnType<typeof setInterval> | undefined;
  private consentUrl: string | null = null;
  private sourceUrl: string | null = null;
  private recordSession = 0;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.recorder.dispose();
    this.clearTimer();
    this.revokeUrls();
  }

  private get client() {
    const snapshot = this.context?.gateway.snapshot;
    return this.isConnected && snapshot?.phase === "connected" ? snapshot.client : null;
  }

  private get canWrite() {
    return hasOperatorWriteAccess(this.context?.gateway.snapshot.hello?.auth ?? null);
  }

  private get replicationAdvertised() {
    return isGatewayMethodAdvertised(this.context?.gateway.snapshot ?? {}, "tts.replicateVoice");
  }

  private readonly voicesTask = new Task(this, {
    args: () => [this.client, this.context?.gateway.snapshot.hello] as const,
    task: async ([client], { signal }) => {
      if (!client || !hasOperatorReadAccess(this.context?.gateway.snapshot.hello?.auth ?? null)) {
        return initialState;
      }
      if (isGatewayMethodAdvertised(this.context.gateway.snapshot, "tts.voices") === false) {
        return { voices: [] as StoredSpeechVoice[] };
      }
      const result = await client.request<VoicesGatewayResult>(
        "tts.voices",
        { provider: GOOGLE_PROVIDER },
        { signal },
      );
      const voices = Array.isArray(result) ? result : (result.voices ?? []);
      return { voices: voices.filter(isStoredSpeechVoice) };
    },
  });

  private openDialog = () => {
    this.dialogOpen = true;
    this.createError = null;
    this.storedPreview = null;
  };

  private closeDialog = () => {
    this.recordSession += 1;
    void this.stopRecording();
    this.pending = null;
    this.dialogOpen = false;
    if (shouldClearCreateErrorOnClose(this.creating) && !this.storeUncertain) {
      this.createError = null;
    }
  };

  private startRecording(slot: ClipSlot) {
    if (this.recording || this.pending || !this.canWrite) {
      return;
    }
    this.createError = null;
    this.storedPreview = null;
    this.pending = slot;
    this.level = 0;
    this.requestNativeMicrophone();
    void this.startRecordingAsync(slot);
  }

  private requestNativeMicrophone() {
    const native = this.context.nativeDeviceSettings;
    const status = native?.snapshot?.permissions?.entries.find(
      (entry) => entry.id === "microphone",
    )?.status;
    if (status === "notDetermined") {
      native.requestPermission("microphone");
    }
  }

  private async startRecordingAsync(slot: ClipSlot) {
    const session = this.recordSession;
    try {
      await this.recorder.start({
        deviceId: this.context.theme.settings.realtimeTalkInputDeviceId,
        onLevel: (level) => {
          this.level = level;
        },
      });
      if (
        !shouldAcceptMicStart({
          session,
          currentSession: this.recordSession,
          dialogOpen: this.dialogOpen,
        })
      ) {
        this.recorder.dispose();
        this.pending = null;
        return;
      }
      this.recording = slot;
      this.pending = null;
      this.elapsedMs = 0;
      this.clearTimer();
      this.elapsedTimer = setInterval(() => {
        this.elapsedMs = this.recorder.elapsedMs;
        if (this.elapsedMs >= TTS_CLIP_MAX_DURATION_MS) {
          void this.stopRecording();
        }
      }, 200);
    } catch (error) {
      this.pending = null;
      if (error instanceof TtsClipRecorderCancelledError) {
        return;
      }
      if (
        shouldAcceptMicStart({
          session,
          currentSession: this.recordSession,
          dialogOpen: this.dialogOpen,
        })
      ) {
        this.createError = formatUiError(error);
      }
    }
  }

  private async stopRecording() {
    if (!this.recording) {
      this.recorder.dispose();
      this.clearTimer();
      return;
    }
    const slot = this.recording;
    this.clearTimer();
    try {
      const clip = await this.recorder.stop();
      this.setClip(slot, clip);
    } catch (error) {
      this.createError = formatUiError(error);
    } finally {
      this.recording = null;
      this.elapsedMs = 0;
    }
  }

  private setClip(slot: ClipSlot, clip: TtsRecordedClip) {
    if (slot === "consent") {
      if (this.consentUrl) {
        URL.revokeObjectURL(this.consentUrl);
      }
      this.consent = clip;
      this.consentUrl = clipObjectUrl(clip);
      return;
    }
    if (this.sourceUrl) {
      URL.revokeObjectURL(this.sourceUrl);
    }
    this.source = clip;
    this.sourceUrl = clipObjectUrl(clip);
  }

  private async createVoice() {
    const client = this.client;
    const block = voiceLabSubmitBlock({
      name: this.displayName,
      consentMs: this.consent?.durationMs ?? 0,
      sourceMs: this.source?.durationMs ?? 0,
      connected: Boolean(client),
      storeUncertain: this.storeUncertain,
    });
    if (!client || this.creating || !this.consent || !this.source || block) {
      this.createError = t(`ttsVoiceLab.${block ?? "createError"}`);
      return;
    }
    this.creating = true;
    this.createError = null;
    this.storeUncertain = false;
    const listedVoices = (result: VoicesGatewayResult): StoredSpeechVoice[] => {
      const voices = Array.isArray(result) ? result : (result.voices ?? []);
      return voices.filter(isStoredSpeechVoice);
    };
    let beforeIds: Set<string> | undefined;
    try {
      beforeIds = storedVoiceIds(
        listedVoices(
          await client.request<VoicesGatewayResult>("tts.voices", { provider: GOOGLE_PROVIDER }),
        ),
      );
    } catch {
      beforeIds = undefined;
    }
    try {
      const result = await client.request<ReplicateGatewayResult>("tts.replicateVoice", {
        provider: GOOGLE_PROVIDER,
        displayName: this.displayName.trim(),
        sourceAudioBase64: bytesToBase64(this.source.wav),
        consentAudioBase64: bytesToBase64(this.consent.wav),
        sourceMimeType: this.source.mimeType,
        consentMimeType: this.consent.mimeType,
      });
      this.storedPreview = result;
      this.voicesTask.run();
    } catch (error) {
      if (isGoogleVoiceStoreUncertain(error)) {
        this.createError = t("ttsVoiceLab.storeUncertain");
        try {
          const listed = await client.request<VoicesGatewayResult>("tts.voices", {
            provider: GOOGLE_PROVIDER,
          });
          const match =
            beforeIds === undefined
              ? undefined
              : storedVoiceCreatedSince(beforeIds, listedVoices(listed), this.displayName);
          if (match) {
            this.storeUncertain = false;
            this.storedPreview = { id: match.id, name: match.name };
            this.createError = null;
            this.voicesTask.run();
            return;
          }
        } catch {
          // Listing failed; keep the uncertain lock so Store cannot POST again.
        }
        this.storeUncertain = true;
        this.voicesTask.run();
        return;
      }
      this.createError = isGoogleVoiceStoreInternal(error)
        ? t("ttsVoiceLab.googleInternal")
        : formatUiError(error);
    } finally {
      this.creating = false;
    }
  }

  private clearTimer() {
    if (this.elapsedTimer !== undefined) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
  }

  private revokeUrls() {
    if (this.consentUrl) {
      URL.revokeObjectURL(this.consentUrl);
    }
    if (this.sourceUrl) {
      URL.revokeObjectURL(this.sourceUrl);
    }
    this.consentUrl = null;
    this.sourceUrl = null;
  }

  private renderMeter(slot: ClipSlot) {
    if (this.recording !== slot && this.pending !== slot) {
      return nothing;
    }
    const pct = Math.round(Math.min(1, this.level) * 100);
    return html`<div
      role="meter"
      aria-label=${t("ttsVoiceLab.level")}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${String(pct)}
      style="height:8px;border-radius:99px;background:var(--oc-border, #ccc);overflow:hidden"
    >
      <div style="height:100%;width:${pct}%;background:var(--oc-accent, #3b82f6)"></div>
    </div>`;
  }

  private renderClip(slot: ClipSlot, clip: TtsRecordedClip | null, url: string | null) {
    const recording = this.recording === slot;
    const seconds = ((recording ? this.elapsedMs : (clip?.durationMs ?? 0)) / 1000).toFixed(1);
    return html`
      <div class="settings-stack">
        ${
          recording || this.pending === slot
            ? renderSettingsStatus({
                kind: "accent",
                label:
                  this.pending === slot
                    ? t("ttsVoiceLab.pending")
                    : t("ttsVoiceLab.recording", { seconds }),
              })
            : clip
              ? html`<audio controls src=${url ?? ""}></audio> ${renderSettingsStatus({
                    kind: "ok",
                    label: t("ttsVoiceLab.recorded", { seconds }),
                  })}`
              : nothing
        }
        ${this.renderMeter(slot)}
        <button
          type="button"
          class="btn"
          ?disabled=${!this.canWrite || this.pending !== null || (this.recording !== null && !recording)}
          @click=${() => (recording ? void this.stopRecording() : this.startRecording(slot))}
        >
          ${
            this.pending === slot
              ? t("ttsVoiceLab.pending")
              : recording
                ? t("ttsVoiceLab.stop")
                : clip
                  ? t("ttsVoiceLab.rerecord")
                  : t("ttsVoiceLab.record")
          }
        </button>
      </div>
    `;
  }

  private renderDialog() {
    if (!this.dialogOpen) {
      return nothing;
    }
    const submitBlock = voiceLabSubmitBlock({
      name: this.displayName,
      consentMs: this.consent?.durationMs ?? 0,
      sourceMs: this.source?.durationMs ?? 0,
      connected: Boolean(this.client),
      storeUncertain: this.storeUncertain,
    });
    const canSubmit = !this.creating && submitBlock === null;
    return html`
      <openclaw-modal-dialog
        label=${t("ttsVoiceLab.create")}
        description=${t("ttsVoiceLab.intro")}
        @modal-cancel=${this.closeDialog}
      >
        <section class="exec-approval-card" style="max-height:min(80dvh, 720px);overflow:auto">
          <header>
            <h2>${t("ttsVoiceLab.create")}</h2>
            <p>${t("ttsVoiceLab.intro")}</p>
            <p>${t("ttsVoiceLab.inPageRecorder")}</p>
          </header>
          ${this.createError ? renderSettingsStatus({ kind: "danger", label: this.createError }) : nothing}
          <label class="settings-stack">
            ${t("ttsVoiceLab.name")}
            <input
              type="text"
              required
              aria-required="true"
              autocomplete="off"
              .value=${this.displayName}
              placeholder=${t("ttsVoiceLab.namePlaceholder")}
              ?disabled=${this.creating}
              @input=${(event: Event) => {
                this.displayName = (event.target as HTMLInputElement).value;
              }}
            />
          </label>
          <p class="settings-page__intro">${t("ttsVoiceLab.nameEmptyHint")}</p>
          ${renderSettingsSection(
            { title: t("ttsVoiceLab.consentTitle"), description: t("ttsVoiceLab.consentHint") },
            html`<blockquote>${t("ttsVoiceLab.consentStatement")}</blockquote>
              ${this.renderClip("consent", this.consent, this.consentUrl)}`,
          )}
          ${renderSettingsSection(
            { title: t("ttsVoiceLab.sourceTitle"), description: t("ttsVoiceLab.sourceHint") },
            html`<blockquote>${t("ttsVoiceLab.sourceScript")}</blockquote>
              ${this.renderClip("source", this.source, this.sourceUrl)}`,
          )}
          <p class="settings-page__intro">${t("ttsVoiceLab.durationHint")}</p>
          ${
            this.storedPreview?.id
              ? html`${renderSettingsStatus({
                  kind: "ok",
                  label: t("ttsVoiceLab.stored", {
                    name: this.storedPreview.name ?? this.storedPreview.id,
                  }),
                })}
                ${
                  this.storedPreview.audioBase64
                    ? html`<audio
                        controls
                        src=${`data:${this.storedPreview.mimeType ?? "audio/wav"};base64,${this.storedPreview.audioBase64}`}
                      ></audio>`
                    : nothing
                }`
              : nothing
          }
          <footer class="exec-approval-actions">
            ${
              this.createError
                ? renderSettingsStatus({ kind: "danger", label: this.createError })
                : submitBlock
                  ? renderSettingsStatus({
                      kind: "muted",
                      label: t(`ttsVoiceLab.${submitBlock}`),
                    })
                  : nothing
            }
            <button type="button" class="btn" @click=${this.closeDialog}>
              ${t("ttsVoiceLab.close")}
            </button>
            <button
              type="button"
              class="btn primary"
              ?disabled=${!canSubmit || !this.canWrite}
              @click=${() => void this.createVoice()}
            >
              ${this.creating ? t("ttsVoiceLab.creating") : t("ttsVoiceLab.createVoice")}
            </button>
          </footer>
        </section>
      </openclaw-modal-dialog>
    `;
  }

  private renderLab() {
    const advertised = this.replicationAdvertised;
    const voices =
      this.voicesTask.status === TaskStatus.COMPLETE ? (this.voicesTask.value?.voices ?? []) : [];
    const listError =
      this.voicesTask.status === TaskStatus.ERROR ? formatUiError(this.voicesTask.error) : null;
    return renderSettingsPage(html`
      <div class="settings-stack" id=${COMMUNICATION_SETTINGS_TARGET_IDS.ttsVoiceLab}>
        ${renderSettingsSection(
          {
            title: t("ttsVoiceLab.title"),
            description: t("ttsVoiceLab.intro"),
            actions: html`<button
              type="button"
              class="btn primary"
              ?disabled=${advertised === false || !this.client || !this.canWrite}
              @click=${this.openDialog}
            >
              ${t("ttsVoiceLab.create")}
            </button>`,
          },
          html`
            ${
              !this.client
                ? renderSettingsStatus({ kind: "muted", label: t("ttsVoiceLab.disconnected") })
                : advertised === false
                  ? renderSettingsStatus({ kind: "warn", label: t("ttsVoiceLab.unavailable") })
                  : nothing
            }
            ${listError ? renderSettingsStatus({ kind: "danger", label: listError }) : nothing}
            ${
              voices.length === 0 && !listError
                ? html`<p class="settings-page__intro">${t("ttsVoiceLab.empty")}</p>`
                : voices.map((voice) =>
                    renderSettingsRow({
                      title: voice.name ?? voice.id,
                      description: voice.id,
                    }),
                  )
            }
            <p class="settings-page__intro">${t("ttsVoiceLab.talkHint")}</p>
          `,
        )}
      </div>
    `);
  }

  override render() {
    return html`${this.editor}
      <details class="settings-page" ?open=${this.advancedExpanded}>
        <summary class="settings-section__heading">${t("ttsVoiceLab.advancedSettings")}</summary>
        ${this.renderLab()}
      </details>
      ${this.renderDialog()}`;
  }
}

if (!customElements.get("openclaw-tts-voice-lab")) {
  customElements.define("openclaw-tts-voice-lab", TtsVoiceLabSettings);
}

export function renderTtsVoiceLab(props: {
  mutationDisabled: boolean;
  advancedExpanded: boolean;
  editor: TemplateResult | typeof nothing;
}) {
  return html`<openclaw-tts-voice-lab
    .mutationDisabled=${props.mutationDisabled}
    .advancedExpanded=${props.advancedExpanded}
    .editor=${props.editor}
  ></openclaw-tts-voice-lab>`;
}
