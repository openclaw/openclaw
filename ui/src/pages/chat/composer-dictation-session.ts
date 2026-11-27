import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { registerChatDictationEnglish } from "../../i18n/locales/en-chat-dictation.ts";
import { bytesToBase64 } from "../../lib/bytes-base64.ts";
import { focusComposerInput, selectComposerInput } from "../../lib/composer-input.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { adjustTextareaHeight } from "./components/chat-composer-dom.ts";
import type { ChatComposerProps, ChatComposerState } from "./components/chat-composer-types.ts";
import type { DictationReferenceReceipt } from "./composer-file-references.ts";
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

export type ComposerDictationReview = (
  receipt: DictationReferenceReceipt | undefined,
  final: boolean,
) => void;

type ComposerDictationSessionCallbacks = {
  onError: (message: string, preservesText: boolean) => void;
  onLevel?: (level: number) => void;
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
  readonly applyChatTranscript = applyChatTranscript;

  get size(): number {
    return this.sessions.size;
  }

  has(session: ComposerDictationSession): boolean {
    return this.sessions.has(session);
  }

  /** Delivers once earlier recordings settle; a retired recording resolves false. */
  add(
    session: ComposerDictationSession,
    deliver: (transcript: string, final: boolean) => boolean,
  ): Promise<boolean> {
    const previous = this.tail;
    this.sessions.add(session);
    if (session.review) {
      session.trackFinality();
    }
    const settled = session
      .finish(true)
      .catch(() => "")
      .then(async (transcript) => {
        // Keep the session owned until its close receipt settles, so cancellation
        // and disconnect still reach it while a final transcript is already here.
        const final = session.review ? await session.finalized() : false;
        await previous;
        return this.sessions.delete(session) && deliver(transcript, final);
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
  { value, start: selectionStart, end: selectionEnd }: DictationSelection,
  transcript: string,
  maxLength = -1,
): { value: string; caret: number; from: number; to: number } {
  const spoken = transcript.trim();
  if (!spoken) {
    return { value, caret: selectionEnd, from: selectionEnd, to: selectionEnd };
  }
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leadingSpace = before && !/\s$/.test(before) && !/^\s|^[,.;:!?)]/.test(spoken) ? " " : "";
  const trailingSpace =
    after && !/^\s|^[,.;:!?)]/.test(after) && !/[\s([{]$/.test(spoken) ? " " : "";
  const replacement = `${leadingSpace}${spoken}${trailingSpace}`;
  const inserted =
    maxLength < 0
      ? replacement
      : truncateUtf16Safe(replacement, maxLength - before.length - after.length);
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
    from: before.length + Math.min(leadingSpace.length, inserted.length),
    to: before.length + Math.min(leadingSpace.length + spoken.length, inserted.length),
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
  live: DictationSelection & { maxLength?: number },
  late?: true,
  preservePreview?: true,
): {
  value: string;
  caret: number;
  from: number;
  to: number;
  previousValue: string;
  changed: boolean;
  captured: DictationSelection | null;
} {
  const selection =
    captured && (preservePreview || !late || captured.value === live.value) ? captured : live;
  const insertion = insertComposerDictation(selection, transcript, live.maxLength);
  return {
    ...insertion,
    previousValue: selection.value,
    changed: insertion.value !== selection.value,
    captured: preservePreview
      ? { start: insertion.caret, end: insertion.caret, value: insertion.value }
      : null,
  };
}

// Chat supplies its draft writer; other capture surfaces need not load Chat state.
export function applyChatTranscript(
  props: ChatComposerProps,
  state: ChatComposerState,
  commitDraft: (props: ChatComposerProps, value: string) => void,
  transcript: string,
  late?: true,
  preservePreview?: true,
): DictationReferenceReceipt | undefined {
  const target = state.composerTextarea;
  const captured = state.dictationSelection;
  // A newer recording may be painting a partial over its captured draft.
  const liveValue = preservePreview
    ? (captured?.value ?? props.getDraft?.() ?? props.draft)
    : (target?.value ?? props.getDraft?.() ?? props.draft);
  const insertion = placeComposerDictation(
    transcript,
    captured,
    {
      start: target?.selectionStart ?? liveValue.length,
      end: target?.selectionEnd ?? liveValue.length,
      value: liveValue,
      maxLength: target?.maxLength,
    },
    late,
    preservePreview,
  );
  if (target) {
    target.value = insertion.value;
    adjustTextareaHeight(target);
  }
  commitDraft(props, insertion.value);
  state.dictationSelection = insertion.captured;
  queueMicrotask(() => {
    const textarea = state.composerTextarea;
    if (!textarea || textarea !== target) {
      return;
    }
    focusComposerInput(textarea, { preventScroll: true });
    selectComposerInput(textarea, insertion.caret, insertion.caret);
  });
  if (!target) {
    return undefined;
  }
  const text = insertion.value.slice(insertion.from, insertion.to);
  return {
    target,
    text,
    complete: text === transcript.trim(),
    from: insertion.from,
    to: insertion.to,
    previousValue: insertion.previousValue,
    value: insertion.value,
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
  private startPromise: Promise<void> | null = null;
  private appendChain: Promise<void> = Promise.resolve();
  private closeRequest: { discard: boolean; promise: Promise<void> } | null = null;
  private stopped = false;
  private discarded = false;
  private failed = false;
  private gatewayDisconnected = false;
  private providerFinal = false;
  private completedClose = false;
  private closeAcknowledged = false;
  private unfinishedPartial = false;
  private finalityInterrupted = false;
  private retainFinalityListener = false;
  private finalityUnsubscribe: (() => void) | undefined;
  private interruptFinalityWait: (() => void) | undefined;
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
    readonly review?: ComposerDictationReview,
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
          this.unfinishedPartial = true;
        } else if (text) {
          this.finalTranscripts.push(text);
          this.currentPartial = "";
          this.providerFinal = true;
          this.unfinishedPartial = false;
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
      } else if (payload.type === "close" && payload.reason === "completed") {
        this.completedClose = true;
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

  /** Observe finality through the close acknowledgement, including events after close. */
  trackFinality(): void {
    this.retainFinalityListener = true;
  }

  /** Rich-reference review requires provider finality and the successful close receipt. */
  async finalized(): Promise<boolean> {
    if (!this.discarded && !this.gatewayDisconnected && !this.failed) {
      await Promise.race([
        this.closeRequest?.promise,
        new Promise<void>((resolve) => {
          this.interruptFinalityWait = resolve;
        }),
      ]);
    }
    this.finalityUnsubscribe?.();
    this.finalityUnsubscribe = undefined;
    this.retainFinalityListener = false;
    this.interruptFinalityWait = undefined;
    return (
      this.providerFinal &&
      this.completedClose &&
      this.closeAcknowledged &&
      !this.unfinishedPartial &&
      !this.finalityInterrupted &&
      !this.failed &&
      !this.gatewayDisconnected &&
      !this.discarded
    );
  }

  async finish(requireTranscript?: true): Promise<string> {
    const transcript =
      this.gatewayDisconnected || this.failed ? this.transcriptSnapshot() : this.waitForLateFinal();
    // Bound admission separately; a started close uses the media provider timeout.
    void this.stopAndClose(true).catch(() => undefined);
    const text = await transcript;
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

  async cancel(): Promise<void> {
    this.discarded = true;
    this.retainFinalityListener = false;
    this.finalityUnsubscribe?.();
    this.finalityUnsubscribe = undefined;
    this.interruptFinalityWait?.();
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
    this.interruptFinalityWait?.();
    this.settleLateFinalDrain?.(false);
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
    this.settleLateFinalDrain?.(false);
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
        .then(() => {
          this.closeAcknowledged = !discard;
        })
        .catch(() => {
          this.closeAcknowledged = false;
        })
        .finally(() => this.resumeFinalDrain?.());
      this.closeRequest = { discard, promise };
    }
    return this.closeRequest.promise;
  }

  private waitForLateFinal(): Promise<string> {
    return new Promise((resolve) => {
      const initialTranscript = this.transcriptSnapshot();
      const transcripts: string[] = [...this.finalTranscripts];
      let partial = this.currentPartial;
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      let unsubscribe = () => {};
      let settled = false;
      const finish = (text: string) => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        if (this.retainFinalityListener) {
          // The same drain owner watches for invalidation until close acknowledges.
          // Text settles once; later events can only revoke rich-reference eligibility.
          this.finalityUnsubscribe = unsubscribe;
        } else {
          unsubscribe();
        }
        this.settleLateFinalDrain = null;
        this.pauseFinalDrain = null;
        this.resumeFinalDrain = null;
        resolve(text);
      };
      const transcript = () => [...transcripts, partial].filter(Boolean).join(" ").trim();
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
          this.retainFinalityListener &&
          (payload.type === "error" ||
            (payload.type === "close" && payload.reason !== "completed") ||
            (this.completedClose && (payload.type === "partial" || payload.type === "transcript")))
        ) {
          this.finalityInterrupted = true;
        }
        if (settled) {
          return;
        }
        if (
          payload.type === "transcript" &&
          payload.final === true &&
          typeof payload.text === "string" &&
          payload.text.trim()
        ) {
          transcripts.push(payload.text.trim());
          partial = "";
          this.providerFinal = true;
          this.unfinishedPartial = false;
        } else if (
          payload.type === "partial" ||
          (payload.type === "transcript" && payload.final !== true)
        ) {
          this.unfinishedPartial = true;
        } else if (payload.type === "error" || payload.type === "close") {
          if (payload.type === "error" || payload.reason === "error") {
            this.reportFailure(
              formatUiExternalText(
                typeof payload.message === "string" ? payload.message : undefined,
                t("chat.composer.dictationFailed"),
              ),
            );
          } else {
            this.completedClose = payload.reason === "completed";
            finish(transcript());
          }
        }
      });
      // Failed finalization retains the preview, not its provisional result.
      this.settleLateFinalDrain = (discard) =>
        finish(discard ? "" : this.failed ? initialTranscript : transcript());
    });
  }
}
