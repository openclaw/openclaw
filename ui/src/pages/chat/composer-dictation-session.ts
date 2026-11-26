import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { registerChatDictationEnglish } from "../../i18n/locales/en-chat-dictation.ts";
import { bytesToBase64 } from "../../lib/bytes-base64.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import {
  floatToG711Ulaw,
  measureRealtimeTalkAudioFrame,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmInputPump,
} from "./talk/audio.ts";
import { describeRealtimeTalkInputError, RealtimeTalkInputOwner } from "./talk/input.ts";
import { RealtimeTalkLevelSignal } from "./talk/level.ts";

registerEnglishCatalog(registerChatDictationEnglish);

const FINAL_TRANSCRIPT_MAX_WAIT_MS = 10_000;
const REFINEMENT_FINALIZATION_MAX_WAIT_MS = 2_500;
const DICTATION_ENCODING = "g711_ulaw";
const DICTATION_SAMPLE_RATE_HZ = 8000;

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
  onLevel?: (level: number) => void;
  onTranscriptChange: () => void;
  onReady: () => void;
  onSilence?: () => void;
};

export type ComposerDictationFinalSnapshot = Readonly<{
  /** Recognizer-final segments only; an incomplete capture is never eligible refinement input. */
  text: string;
  revision: number;
  isFinal: boolean;
  /** Preserved for manual recovery, never silently promoted to a finalized transcript. */
  incompleteText: string;
  reason: "complete" | "timeout" | "disconnected" | "error" | "cancelled";
}>;

type DictationFinalization = {
  snapshot: ComposerDictationFinalSnapshot;
  // Disabled refinement and split Talk retain their existing preview-recovery contract.
  baselineText: string;
};

// Transcription relay events use the shared transcriptionSessionId envelope;
// the canonical TalkEvent rides alongside it as `talkEvent`.
function eventPayload(frame: GatewayEventFrame) {
  if (frame.event !== "talk.event" || !frame.payload || typeof frame.payload !== "object") {
    return null;
  }
  return asOptionalObjectRecord(frame.payload) ?? null;
}

function formatDictationError(error: unknown): string {
  if (error instanceof DOMException) {
    return describeRealtimeTalkInputError(error);
  }
  return formatUiError(error);
}

/**
 * Stopped recordings that still await their final transcript. Each keeps its
 * Gateway session until settled; results are delivered in capture order, even
 * when a later recording's provider finishes first.
 */
export class ComposerDictationCommits {
  private readonly sessions = new Set<ComposerDictationSession>();
  private tail: Promise<unknown> = Promise.resolve();
  // Consumers place delivered and preview transcripts in their drafts.
  readonly place = placeComposerDictation;

  get size(): number {
    return this.sessions.size;
  }

  has(session: ComposerDictationSession): boolean {
    return this.sessions.has(session);
  }

  /** Delivers once earlier recordings settle; a retired recording resolves false. */
  add(
    session: ComposerDictationSession,
    deliver: (transcript: string) => boolean,
  ): Promise<boolean> {
    const previous = this.tail;
    this.sessions.add(session);
    const settled = session
      .finish(true)
      .catch(() => "")
      .then(async (transcript) => {
        await previous;
        return this.sessions.delete(session) && deliver(transcript);
      })
      .catch(() => false);
    this.tail = settled;
    return settled;
  }

  markGatewayDisconnected(): void {
    for (const session of this.sessions) {
      session.markGatewayDisconnected();
    }
  }

  retire(): void {
    for (const session of this.sessions) {
      void session.cancel().catch(() => undefined);
    }
    this.sessions.clear();
  }
}

function insertComposerDictation(
  value: string,
  transcript: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; caret: number } {
  const spoken = transcript.trim();
  if (!spoken) {
    return { value, caret: selectionEnd };
  }
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leadingSpace = before && !/\s$/.test(before) && !/^\s|^[,.;:!?)]/.test(spoken) ? " " : "";
  const trailingSpace =
    after && !/^\s|^[,.;:!?)]/.test(after) && !/[\s([{]$/.test(spoken) ? " " : "";
  const inserted = `${leadingSpace}${spoken}${trailingSpace}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

type DictationSelection = { start: number; end: number; value: string };

/**
 * Places a transcript in a draft. The captured selection holds unless a late final
 * finds the draft edited after Stop; with a newer recording's preview painted over
 * the draft, the next result chains from the captured draft instead.
 */
export function placeComposerDictation(
  transcript: string,
  captured: DictationSelection | null,
  live: DictationSelection,
  late?: true,
  preservePreview?: true,
): { value: string; caret: number; changed: boolean; captured: DictationSelection | null } {
  const selection =
    captured && (preservePreview || !late || captured.value === live.value) ? captured : live;
  const insertion = insertComposerDictation(
    selection.value,
    transcript,
    selection.start,
    selection.end,
  );
  return {
    ...insertion,
    changed: insertion.value !== selection.value,
    captured: preservePreview
      ? { start: insertion.caret, end: insertion.caret, value: insertion.value }
      : null,
  };
}

export function describeDictationStartError(error: unknown): [string, "busy" | "start"] {
  // Stopped recordings hold their Gateway sessions until transcribed; a full
  // connection refuses the next one before its microphone opens.
  const details = asOptionalObjectRecord(asOptionalObjectRecord(error)?.details);
  return details?.code === "TALK_SESSION_CAPACITY"
    ? [t("chat.dictation.busy"), "busy"]
    : [formatDictationError(error), "start"];
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export class ComposerDictationSession {
  private readonly input = new RealtimeTalkInputOwner((detail) => this.reportFailure(detail));
  private context: AudioContext | null = null;
  private readonly inputPump = new RealtimeTalkPcmInputPump();
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  // Live microphone level for the listening meter; lives with the lazily loaded capture.
  readonly inputLevel = new RealtimeTalkLevelSignal();
  private unsubscribe: (() => void) | null = null;
  private sessionId: string | null = null;
  private transcriptionSessionId: string | null = null;
  private readonly finalTranscripts: string[] = [];
  private currentPartial = "";
  private transcriptRevision = 0;
  private lastTalkSequence = 0;
  private lastFinalTurnId: string | undefined;
  private finalization: Promise<DictationFinalization> | null = null;
  private finalizationTimeoutMs: number | null = null;
  private startPromise: Promise<void> | null = null;
  private appendChain: Promise<void> = Promise.resolve();
  private closeRequest: { discard: boolean; promise: Promise<void> } | null = null;
  private stopped = false;
  private discarded = false;
  private failed = false;
  private gatewayDisconnected = false;
  private settleLateFinalDrain:
    | ((reason: ComposerDictationFinalSnapshot["reason"]) => void)
    | null = null;
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
    // Start the audio graph while the Gateway admits the session instead of after it.
    // stopCapture() closes the context on every exit.
    try {
      this.context = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE_HZ });
    } catch {
      this.context = null;
    }
    // Claim the Gateway session before the microphone opens. Stopped recordings
    // hold their sessions while they transcribe, so a full connection must refuse
    // here rather than after the user has started speaking.
    const result = await this.client.request<DictationSessionResult>("talk.session.create", {
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
      ...(this.options?.sessionKey ? { sessionKey: this.options.sessionKey } : {}),
    });
    this.sessionId = result.sessionId;
    this.transcriptionSessionId = result.transcriptionSessionId ?? result.sessionId;
    if (this.stopped) {
      return;
    }
    if (
      result.audio?.inputEncoding !== DICTATION_ENCODING ||
      result.audio.inputSampleRateHz !== DICTATION_SAMPLE_RATE_HZ
    ) {
      await this.closeRemote();
      throw new Error(t("chat.composer.dictationAudioUnsupported"));
    }
    // Listen before awaiting the permission prompt: a provider failure while it is
    // open must stop startup instead of capturing against a removed session.
    this.unsubscribe = this.client.addEventListener((frame) => {
      const payload = eventPayload(frame);
      if (
        !payload ||
        payload.transcriptionSessionId !== this.transcriptionSessionId ||
        this.stopped ||
        !this.acceptEvent(payload)
      ) {
        return;
      }
      if (
        (payload.type === "transcript" || payload.type === "partial") &&
        typeof payload.text === "string"
      ) {
        const transcript = this.readTranscript(payload);
        if (!transcript) {
          return;
        }
        if (!transcript.final) {
          this.currentPartial = transcript.text;
        } else {
          this.finalTranscripts.push(transcript.text);
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
    });
    const media = await this.input.open(inputDeviceId);
    if (this.stopped || this.failed) {
      return;
    }
    if (this.context?.sampleRate !== DICTATION_SAMPLE_RATE_HZ) {
      throw new Error(t("chat.composer.dictationBrowserAudioUnsupported"));
    }
    const context = this.context;
    this.inputMeter = new RealtimeTalkMediaStreamMeter((level) => {
      this.inputLevel.set(level);
      this.callbacks.onLevel?.(level);
    });
    this.inputMeter.start(media, context);
    this.inputPump.start(media, context, (samples) => {
      if (this.stopped) {
        return;
      }
      this.queueAudio(samples);
      this.detectSilence(samples);
    });
    this.callbacks.onReady();
  }

  transcriptSnapshot(): string {
    return [...this.finalTranscripts, this.currentPartial].filter(Boolean).join(" ").trim();
  }

  async finish(requireTranscript?: true): Promise<string> {
    const { baselineText: text } = await this.beginFinalization();
    // Composer dictation needs a visible outcome; split Talk can quietly listen again.
    // Cancellation and already-reported provider failures keep their existing outcomes.
    if (requireTranscript && !text && !this.discarded && !this.failed) {
      this.reportFailure(
        t(
          this.gatewayDisconnected
            ? "chat.composer.dictationDisconnected"
            : "chat.composer.dictationFailed",
        ),
      );
    }
    return text;
  }

  /**
   * Refinement has a hard stop-to-result allowance, including remote close. A final
   * segment alone cannot certify that trailing audio completed after an error or timeout.
   */
  async finishSnapshot(
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ComposerDictationFinalSnapshot> {
    const timeoutMs = options.timeoutMs ?? REFINEMENT_FINALIZATION_MAX_WAIT_MS;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > REFINEMENT_FINALIZATION_MAX_WAIT_MS
    ) {
      throw new RangeError("Dictation finalization timeout must be between 1 and 2500 ms");
    }
    const { snapshot } = await this.beginFinalization({ ...options, timeoutMs });
    return snapshot;
  }

  private beginFinalization(options?: {
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<DictationFinalization> {
    if (!this.finalization) {
      this.finalizationTimeoutMs = options?.timeoutMs ?? null;
      this.finalization = this.waitForLateFinal(options);
      // Stop the microphone synchronously; neither completion nor cancellation waits
      // for a provider's close reply. The existing remote owner releases its transport.
      void this.stopAndClose(true).catch(() => undefined);
    }
    return this.finalization;
  }

  async cancel(): Promise<void> {
    this.discarded = true;
    this.settleLateFinalDrain?.("cancelled");
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
    this.settleLateFinalDrain?.("disconnected");
    return this.hasTranscript();
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

  private reportFailure(message: string): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.settleLateFinalDrain?.("error");
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
          { timeoutMs: this.finalizationTimeoutMs },
        )
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => this.resumeFinalDrain?.());
      this.closeRequest = { discard, promise };
    }
    return this.closeRequest.promise;
  }

  private acceptEvent(payload: Record<string, unknown>): boolean {
    const event = asOptionalObjectRecord(payload.talkEvent);
    // The relay envelope also supports providers without canonical Talk events.
    if (!event) {
      return true;
    }
    if (
      event.sessionId !== this.transcriptionSessionId ||
      typeof event.seq !== "number" ||
      !Number.isSafeInteger(event.seq) ||
      event.seq <= this.lastTalkSequence
    ) {
      return false;
    }
    this.lastTalkSequence = event.seq;
    return true;
  }

  private readTranscript(
    payload: Record<string, unknown>,
  ): { text: string; final: boolean } | null {
    if (typeof payload.text !== "string") {
      return null;
    }
    const event = asOptionalObjectRecord(payload.talkEvent);
    const turnId = typeof event?.turnId === "string" ? event.turnId : undefined;
    if (turnId && turnId === this.lastFinalTurnId) {
      return null;
    }
    const text = payload.text.trim();
    const final = payload.type === "transcript" && payload.final === true;
    // The relay also emits empty transcript-shaped turn/commit bookkeeping.
    if (final && !text) {
      return null;
    }
    this.transcriptRevision += 1;
    if (final) {
      this.lastFinalTurnId = turnId;
    }
    return { text, final };
  }

  private waitForLateFinal(options?: {
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<DictationFinalization> {
    return new Promise((resolve) => {
      const initialTranscript = this.transcriptSnapshot();
      const transcripts: string[] = [...this.finalTranscripts];
      let partial = this.currentPartial;
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      let settled = false;
      let unsubscribe = () => {};
      let unlistenAbort: (() => void) | undefined;
      const finish = (reason: ComposerDictationFinalSnapshot["reason"]) => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        unsubscribe();
        unlistenAbort?.();
        this.settleLateFinalDrain = null;
        this.pauseFinalDrain = null;
        this.resumeFinalDrain = null;
        const text = reason === "cancelled" ? "" : transcripts.join(" ").trim();
        const isFinal = reason === "complete" && Boolean(text) && !partial;
        const incompleteText = reason === "cancelled" || isFinal ? "" : transcript();
        resolve({
          snapshot: Object.freeze({
            text,
            revision: this.transcriptRevision,
            isFinal,
            incompleteText,
            reason,
          }),
          baselineText:
            reason === "cancelled" ? "" : reason === "error" ? initialTranscript : transcript(),
        });
      };
      const transcript = () => [...transcripts, partial].filter(Boolean).join(" ").trim();
      const abort = () => {
        finish("cancelled");
        void this.cancel().catch(() => undefined);
      };
      if (options) {
        timer = globalThis.setTimeout(() => {
          finish("timeout");
          void this.cancel().catch(() => undefined);
        }, options.timeoutMs);
        if (options.signal) {
          unlistenAbort = listen(options.signal, "abort", abort, { once: true });
        }
      } else {
        // Baseline dictation retains the provider-owned close allowance and late grace.
        this.pauseFinalDrain = () => globalThis.clearTimeout(timer);
        this.resumeFinalDrain = () => {
          timer = globalThis.setTimeout(() => finish("timeout"), FINAL_TRANSCRIPT_MAX_WAIT_MS);
        };
        this.resumeFinalDrain();
      }
      unsubscribe = this.client.addEventListener((frame) => {
        const payload = eventPayload(frame);
        if (
          !payload ||
          payload.transcriptionSessionId !== this.transcriptionSessionId ||
          !this.acceptEvent(payload)
        ) {
          return;
        }
        if (
          (payload.type === "transcript" && payload.final === true) ||
          (options && (payload.type === "partial" || payload.type === "transcript"))
        ) {
          const recognized = this.readTranscript(payload);
          if (recognized?.final) {
            transcripts.push(recognized.text);
            partial = "";
          } else if (recognized) {
            partial = recognized.text;
          }
        } else if (payload.type === "error" || payload.type === "close") {
          if (payload.type === "error" || payload.reason === "error") {
            this.reportFailure(
              formatUiExternalText(
                typeof payload.message === "string" ? payload.message : undefined,
                t("chat.composer.dictationFailed"),
              ),
            );
          } else {
            finish("complete");
          }
        }
      });
      // Failed finalization retains the preview, not its provisional result.
      this.settleLateFinalDrain = finish;
      if (this.discarded || options?.signal?.aborted) {
        abort();
      } else if (this.failed || this.gatewayDisconnected) {
        finish(this.failed ? "error" : "disconnected");
      }
    });
  }
}
