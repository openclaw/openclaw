// Gateway-relay dictation session: owns microphone capture, the
// talk.session.create/appendAudio/close RPC chain, and transcription event
// handling. Split from composer-dictation.ts to keep both files lintable.
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import {
  bytesToBase64,
  floatToG711Ulaw,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmInputPump,
} from "./realtime-talk-audio.ts";
import {
  describeRealtimeTalkInputError,
  RealtimeTalkInputController,
} from "./realtime-talk-input.ts";

const FINAL_TRANSCRIPT_MAX_WAIT_MS = 10_000;
const DICTATION_ENCODING = "g711_ulaw";
const DICTATION_SAMPLE_RATE_HZ = 8000;
const MAX_PENDING_AUDIO_SAMPLES = DICTATION_SAMPLE_RATE_HZ * 10;

// Transcription relay talk.event payload (src/gateway/talk-transcription-relay.ts):
// the transcriptionSessionId envelope is the relay's emission shape, shared with the
// Android dictation client; the canonical TalkEvent rides alongside as 	alkEvent.
type DictationEvent = {
  transcriptionSessionId?: unknown;
  type?: unknown;
  text?: unknown;
  final?: unknown;
  message?: unknown;
  reason?: unknown;
};

type DictationSessionResult = {
  sessionId: string;
  transcriptionSessionId?: string;
  /**
   * Relays that defer readiness while their STT provider warms up send
   * ready: false and confirm via the session.ready event (or the first
   * partial). Absent means the peer has no readiness handshake - treat as
   * ready immediately.
   */
  ready?: boolean;
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
};

function eventPayload(frame: GatewayEventFrame): DictationEvent | null {
  if (frame.event !== "talk.event" || !frame.payload || typeof frame.payload !== "object") {
    return null;
  }
  // SAFETY: the relay only emits talk.event frames with object payloads; the cast narrows the envelope.
  return frame.payload as DictationEvent;
}

export function messageFromError(error: unknown): string {
  if (error instanceof DOMException) {
    return describeRealtimeTalkInputError(error);
  }
  return formatUiError(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function composeDictationRecoveryMessage(
  message: string,
  failure: { kind: "interrupted" | "start"; preservesText: boolean },
): string {
  const recovery =
    failure.kind === "interrupted" && failure.preservesText
      ? t("chat.composer.dictationInterruptedRecovery")
      : t("chat.composer.dictationStartRecovery");
  return `${message} ${recovery}`;
}

export class ComposerDictationSession {
  private readonly input = new RealtimeTalkInputController((detail) => this.reportFailure(detail));
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
  private closePromise: Promise<void> | null = null;
  private stopped = false;
  private discarded = false;
  private failed = false;
  private gatewayDisconnected = false;
  private settleLateFinalDrain: ((discard: boolean) => void) | null = null;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly callbacks: ComposerDictationSessionCallbacks,
  ) {}

  start(): Promise<void> {
    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const inputDeviceId = loadSettings().realtimeTalkInputDeviceId?.trim() || undefined;
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

    const result = await this.client.request<DictationSessionResult>("talk.session.create", {
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
    });
    this.sessionId = result.sessionId;
    this.transcriptionSessionId = result.transcriptionSessionId ?? result.sessionId;
    if (this.pendingReadySessionId === this.transcriptionSessionId) {
      // The relay can confirm readiness before the create response lands.
      this.pendingReadySessionId = null;
      this.confirmReady();
    } else if (result.ready !== false) {
      // Peers without a readiness handshake are ready with the response;
      // relays that defer send ready: false and confirm via the
      // session.ready event or the first partial.
      this.confirmReady();
    }
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
      await this.appendChain;
      await this.closeRemote();
    }
  }

  transcriptSnapshot(): string {
    return this.transcriptIncludingPartial();
  }

  async finish(drainFinalTranscript = false): Promise<string> {
    const lateFinal =
      drainFinalTranscript && !this.gatewayDisconnected ? this.waitForLateFinal() : null;
    const cleanup = this.stopAndClose(true);
    if (lateFinal) {
      // The bounded final result must not inherit stalled create, append, or close RPCs.
      void cleanup.catch(() => undefined);
      return lateFinal;
    }
    return cleanup.then(() => this.transcriptIncludingPartial());
  }

  async cancel(): Promise<void> {
    this.discarded = true;
    await this.stopAndClose(false);
  }

  private async stopAndClose(reportStartFailure: boolean): Promise<void> {
    await this.stopCapture();
    await this.startPromise?.catch((error: unknown) => {
      if (reportStartFailure && !isAbortError(error)) {
        this.reportFailure(messageFromError(error));
      }
    });
    await this.appendChain;
    await this.closeRemote();
  }

  markGatewayDisconnected(): boolean {
    this.gatewayDisconnected = true;
    this.settleLateFinalDrain?.(false);
    return this.hasTranscript();
  }

  cancelPendingFinal(): void {
    this.settleLateFinalDrain?.(true);
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
      return;
    }
    this.queueAudio(samples);
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
        await this.client.request("talk.session.appendAudio", { sessionId, audioBase64 });
      })
      .catch((error: unknown) => {
        this.reportFailure(messageFromError(error));
      });
  }

  private handleEvent(frame: GatewayEventFrame): void {
    const payload = eventPayload(frame);
    if (payload?.type === "ready" && !this.readyConfirmed) {
      if (this.transcriptionSessionId === null) {
        // The relay can confirm readiness before the create response lands.
        this.pendingReadySessionId = payload.transcriptionSessionId;
        return;
      }
      if (payload.transcriptionSessionId === this.transcriptionSessionId) {
        this.confirmReady();
      }
      return;
    }
    if (
      !payload ||
      payload.transcriptionSessionId !== this.transcriptionSessionId ||
      this.stopped
    ) {
      return;
    }
    if (payload.type === "transcript" && typeof payload.text === "string") {
      this.confirmReady();
      const text = payload.text.trim();
      if (payload.final !== true) {
        this.currentPartial = text;
        this.callbacks.onTranscriptChange();
        return;
      }
      if (text) {
        this.finalTranscripts.push(text);
        this.currentPartial = "";
      }
      this.callbacks.onTranscriptChange();
      return;
    }
    if (payload.type === "partial" && typeof payload.text === "string") {
      this.confirmReady();
      this.currentPartial = payload.text.trim();
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

  private readyConfirmed = false;
  private pendingReadySessionId: unknown = null;

  private confirmReady(): void {
    if (this.readyConfirmed) {
      return;
    }
    this.readyConfirmed = true;
    this.callbacks.onReady();
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

  private transcriptIncludingPartial(): string {
    return [...this.finalTranscripts, this.currentPartial].filter(Boolean).join(" ").trim();
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
    this.closePromise ??= this.client
      .request("talk.session.close", { sessionId: this.sessionId })
      .then(() => undefined)
      .catch(() => undefined);
    return this.closePromise;
  }

  private waitForLateFinal(): Promise<string> {
    return new Promise((resolve) => {
      const transcripts: string[] = [];
      let unsubscribe = () => {};
      const finish = (text: string) => {
        globalThis.clearTimeout(timer);
        unsubscribe();
        this.settleLateFinalDrain = null;
        resolve(text);
      };
      const transcript = () => transcripts.join(" ").trim();
      const timer = globalThis.setTimeout(() => finish(transcript()), FINAL_TRANSCRIPT_MAX_WAIT_MS);
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
          finish(transcript());
        }
      });
      this.settleLateFinalDrain = (discard) => finish(discard ? "" : transcript());
    });
  }
}
