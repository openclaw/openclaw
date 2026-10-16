import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { bytesToBase64 } from "../../lib/bytes-base64.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import {
  floatToG711Ulaw,
  measureRealtimeTalkAudioFrame,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmInputPump,
} from "./talk/audio.ts";
import { describeRealtimeTalkInputError, RealtimeTalkInputOwner } from "./talk/input.ts";

const FINAL_TRANSCRIPT_MAX_WAIT_MS = 10_000;
const DICTATION_ENCODING = "g711_ulaw";
const DICTATION_SAMPLE_RATE_HZ = 8000;
const MAX_PENDING_AUDIO_SAMPLES = DICTATION_SAMPLE_RATE_HZ * 10;

type DictationSessionResult = {
  sessionId: string;
  transcriptionSessionId?: string;
  audio?: {
    inputEncoding?: unknown;
    inputSampleRateHz?: unknown;
  };
};

type ComposerDictationSessionCallbacks = {
  onError: (message: string, preservesText: boolean) => void;
  onLevel: (level: number) => void;
  onTranscriptChange: () => void;
  onReady: () => void;
  onSilence?: () => void;
};

// Transcription relay events use the shared transcriptionSessionId envelope;
// the canonical TalkEvent rides alongside it as `talkEvent`.
function eventPayload(frame: GatewayEventFrame) {
  if (frame.event !== "talk.event" || !frame.payload || typeof frame.payload !== "object") {
    return null;
  }
  return asOptionalObjectRecord(frame.payload) ?? null;
}

export function formatDictationError(error: unknown): string {
  if (error instanceof DOMException) {
    return describeRealtimeTalkInputError(error);
  }
  return formatUiError(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export class ComposerDictationSession {
  private readonly input = new RealtimeTalkInputOwner((detail) => this.reportFailure(detail));
  private context: AudioContext | null = null;
  private readonly inputPump = new RealtimeTalkPcmInputPump();
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  private unsubscribe: (() => void) | null = null;
  private sessionId: string | null = null;
  private transcriptionSessionId: string | null = null;
  private readonly finalTranscripts: string[] = [];
  private currentPartial = "";
  private startPromise: Promise<void> | null = null;
  private readonly pendingAudio: Float32Array[] = [];
  private pendingAudioSamples = 0;
  private appendChain: Promise<void> = Promise.resolve();
  private closeRequest: { discard: boolean; promise: Promise<void> } | null = null;
  private stopped = false;
  private discarded = false;
  private failed = false;
  private gatewayDisconnected = false;
  private settleLateFinalDrain: ((discard: boolean) => void) | null = null;
  private pauseFinalDrain: (() => void) | null = null;
  private resumeFinalDrain: (() => void) | null = null;
  private heardSpeech = false;
  private silentSamples = 0;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly callbacks: ComposerDictationSessionCallbacks,
    private readonly options?: {
      sessionKey?: string;
      inputDeviceId?: string;
      silenceTimeoutMs?: number;
    },
  ) {}

  start(): Promise<void> {
    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const inputDeviceId =
      this.options && "inputDeviceId" in this.options
        ? this.options.inputDeviceId
        : loadSettings().realtimeTalkInputDeviceId?.trim() || undefined;
    const media = await this.input.open(inputDeviceId);
    if (this.stopped) {
      return;
    }
    this.unsubscribe = this.client.addEventListener((frame) => this.handleEvent(frame));
    try {
      this.context = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE_HZ });
    } catch {
      throw new Error(t("chat.composer.dictationBrowserAudioUnsupported"));
    }
    if (this.context.sampleRate !== DICTATION_SAMPLE_RATE_HZ) {
      throw new Error(t("chat.composer.dictationBrowserAudioUnsupported"));
    }
    this.inputMeter = new RealtimeTalkMediaStreamMeter(this.callbacks.onLevel);
    this.inputMeter.start(media, this.context);
    this.inputPump.start(media, this.context, (samples) => this.appendAudio(samples));
    this.callbacks.onReady();

    const result = await this.client.request<DictationSessionResult>("talk.session.create", {
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
      ...(this.options?.sessionKey ? { sessionKey: this.options.sessionKey } : {}),
    });
    this.sessionId = result.sessionId;
    this.transcriptionSessionId = result.transcriptionSessionId ?? result.sessionId;
    if (
      result.audio?.inputEncoding !== DICTATION_ENCODING ||
      result.audio.inputSampleRateHz !== DICTATION_SAMPLE_RATE_HZ
    ) {
      await this.closeRemote();
      throw new Error(t("chat.composer.dictationAudioUnsupported"));
    }
    if (this.discarded) {
      this.pendingAudio.length = 0;
      this.pendingAudioSamples = 0;
    } else {
      this.flushPendingAudio();
    }
    if (this.stopped) {
      if (!this.discarded) {
        await this.appendChain;
      }
      await this.closeRemote();
    }
  }

  transcriptSnapshot(): string {
    return [...this.finalTranscripts, this.currentPartial].filter(Boolean).join(" ").trim();
  }

  async finish(drainFinalTranscript = false): Promise<string> {
    const lateFinal =
      drainFinalTranscript && !this.gatewayDisconnected ? this.waitForLateFinal() : null;
    const cleanup = this.stopAndClose(true);
    if (lateFinal) {
      // Bound admission separately; a started close uses the media provider timeout.
      void cleanup.catch(() => undefined);
      return lateFinal;
    }
    return cleanup.then(() => this.transcriptSnapshot());
  }

  async cancel(): Promise<void> {
    this.discarded = true;
    this.pendingAudio.length = 0;
    this.pendingAudioSamples = 0;
    this.settleLateFinalDrain?.(true);
    await this.stopAndClose(false);
  }

  private async stopAndClose(reportStartFailure: boolean): Promise<void> {
    await this.stopCapture();
    // Startup may already be waiting for a normal close; discard must interrupt it.
    if (!this.discarded || !this.sessionId) {
      await this.startPromise?.catch((error: unknown) => {
        if (reportStartFailure && !isAbortError(error)) {
          this.reportFailure(formatDictationError(error));
        }
      });
    }
    if (!this.discarded) {
      await this.appendChain;
    }
    await this.closeRemote();
  }

  markGatewayDisconnected(): boolean {
    this.gatewayDisconnected = true;
    this.settleLateFinalDrain?.(false);
    return this.hasTranscript();
  }

  private appendAudio(samples: Float32Array): void {
    if (this.stopped) {
      return;
    }
    if (!this.sessionId) {
      const remaining = MAX_PENDING_AUDIO_SAMPLES - this.pendingAudioSamples;
      if (remaining <= 0) {
        return;
      }
      const buffered = samples.slice(0, remaining);
      this.pendingAudio.push(buffered);
      this.pendingAudioSamples += buffered.length;
      this.detectSilence(samples);
      return;
    }
    this.queueAudio(samples);
    this.detectSilence(samples);
  }

  private detectSilence(samples: Float32Array): void {
    if (!this.options?.silenceTimeoutMs || !this.callbacks.onSilence) {
      return;
    }
    if (measureRealtimeTalkAudioFrame(samples).rms >= 0.015) {
      this.heardSpeech = true;
      this.silentSamples = 0;
    } else if (this.heardSpeech) {
      this.silentSamples += samples.length;
      if (this.silentSamples >= (this.options.silenceTimeoutMs * DICTATION_SAMPLE_RATE_HZ) / 1000) {
        this.heardSpeech = false;
        this.callbacks.onSilence();
      }
    }
  }

  private flushPendingAudio(): void {
    const pending = this.pendingAudio.splice(0);
    this.pendingAudioSamples = 0;
    for (const samples of pending) {
      this.queueAudio(samples);
    }
  }

  private queueAudio(samples: Float32Array): void {
    if (!this.sessionId) {
      return;
    }
    const sessionId = this.sessionId;
    const audioBase64 = bytesToBase64(floatToG711Ulaw(samples));
    this.appendChain = this.appendChain
      .then(async () => {
        if (this.discarded) {
          return;
        }
        await this.client.request("talk.session.appendAudio", { sessionId, audioBase64 });
      })
      .catch((error: unknown) => {
        this.reportFailure(formatDictationError(error));
      });
  }

  private handleEvent(frame: GatewayEventFrame): void {
    const payload = eventPayload(frame);
    if (
      !payload ||
      payload.transcriptionSessionId !== this.transcriptionSessionId ||
      this.stopped
    ) {
      return;
    }
    if (
      (payload.type === "transcript" || payload.type === "partial") &&
      typeof payload.text === "string"
    ) {
      const text = payload.text.trim();
      if (payload.type === "partial" || payload.final !== true) {
        this.currentPartial = text;
      } else if (text) {
        this.finalTranscripts.push(text);
        this.currentPartial = "";
      }
      this.callbacks.onTranscriptChange();
      return;
    }
    if (payload.type === "error") {
      this.reportFailure(
        formatUiExternalText(
          typeof payload.message === "string" ? payload.message : undefined,
          t("chat.composer.dictationFailed"),
        ),
      );
      return;
    }
    if (payload.type === "close" && payload.reason === "error") {
      this.reportFailure(t("chat.composer.dictationDisconnected"));
    }
  }

  private reportFailure(message: string): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.callbacks.onError(message, this.hasTranscript());
  }

  private hasTranscript(): boolean {
    return this.finalTranscripts.length > 0 || Boolean(this.currentPartial);
  }

  private async stopCapture(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.input.stop();
    this.inputPump.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.inputMeter?.stop();
    this.inputMeter = null;
    await this.context?.close();
    this.context = null;
  }

  private closeRemote(): Promise<void> {
    if (!this.sessionId) {
      return Promise.resolve();
    }
    if (!this.closeRequest || (this.discarded && !this.closeRequest.discard)) {
      // Buffered STT finalizes during close; its media owner bounds the request.
      // The browser's late-event grace starts only after that work completes.
      this.pauseFinalDrain?.();
      const discard = this.discarded;
      const promise = this.client
        .request(
          "talk.session.close",
          { sessionId: this.sessionId, ...(discard ? { discard } : {}) },
          { timeoutMs: null },
        )
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => this.resumeFinalDrain?.());
      this.closeRequest = { discard, promise };
    }
    return this.closeRequest.promise;
  }

  private waitForLateFinal(): Promise<string> {
    return new Promise((resolve) => {
      const transcripts: string[] = [...this.finalTranscripts];
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      let unsubscribe = () => {};
      const finish = (text: string) => {
        globalThis.clearTimeout(timer);
        unsubscribe();
        this.settleLateFinalDrain = null;
        this.pauseFinalDrain = null;
        this.resumeFinalDrain = null;
        resolve(text);
      };
      const transcript = () => transcripts.join(" ").trim();
      this.pauseFinalDrain = () => globalThis.clearTimeout(timer);
      this.resumeFinalDrain = () => {
        timer = globalThis.setTimeout(() => finish(transcript()), FINAL_TRANSCRIPT_MAX_WAIT_MS);
      };
      this.resumeFinalDrain();
      unsubscribe = this.client.addEventListener((frame) => {
        const payload = eventPayload(frame);
        if (!payload || payload.transcriptionSessionId !== this.transcriptionSessionId) {
          return;
        }
        if (
          payload.type === "transcript" &&
          payload.final === true &&
          typeof payload.text === "string" &&
          payload.text.trim()
        ) {
          transcripts.push(payload.text.trim());
        } else if (payload.type === "error" || payload.type === "close") {
          if (payload.type === "error" || payload.reason === "error") {
            this.reportFailure(
              formatUiExternalText(
                typeof payload.message === "string" ? payload.message : undefined,
                t("chat.composer.dictationFailed"),
              ),
            );
          }
          finish(transcript());
        }
      });
      this.settleLateFinalDrain = (discard) => finish(discard ? "" : transcript());
    });
  }
}
