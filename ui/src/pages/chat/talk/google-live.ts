import { bytesToBase64 } from "../../../lib/bytes-base64.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import {
  estimateBase64DecodedByteLength,
  floatToPcm16,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmInputPump,
  RealtimeTalkPcmOutputQueue,
} from "./audio.ts";
import { RealtimeTalkCameraOwner } from "./camera-owner.ts";
import { buildGoogleLiveUrl, GOOGLE_LIVE_SETUP_TIMEOUT_MS } from "./google-live-lifecycle.ts";
import { GoogleLiveToolOwner, type GoogleLiveFunctionCall } from "./google-live-tools.ts";
import {
  type RealtimeTalkJsonPcmWebSocketSessionResult,
  createRealtimeTalkEventEmitter,
  steerRealtimeTalkActiveConsult,
  shouldAutoControlRealtimeVoiceAgentText,
  shouldInterruptRealtimeTalkControlResponse,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
  type RealtimeTalkTransportStartResult,
} from "./shared.ts";
import { captureRealtimeTalkVideoFrame, type RealtimeTalkVideoFrame } from "./video.ts";

type GoogleLiveMessage = {
  setupComplete?: unknown;
  serverContent?: {
    interrupted?: boolean;
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string; finished?: boolean };
    modelTurn?: {
      parts?: Array<{
        inlineData?: { data?: string; mimeType?: string };
      }>;
    };
    generationComplete?: boolean;
    interactionStatus?: "IN_PROGRESS" | "IDLE" | "INTERACTION_STATUS_UNSPECIFIED";
    turnComplete?: boolean;
  };
  toolCall?: {
    functionCalls?: GoogleLiveFunctionCall[];
  };
  toolCallCancellation?: {
    ids?: string[];
  };
};

const GOOGLE_LIVE_VIDEO_FRAME_INTERVAL_MS = 1_000;
const GOOGLE_LIVE_VIDEO_MESSAGE_MAX_BYTES = 512 * 1024;
const GOOGLE_LIVE_MAX_TRANSCRIPT_BYTES = 256 * 1024;
const utf8Encoder = new TextEncoder();
function googleLiveVideoMessage(frame: RealtimeTalkVideoFrame): unknown {
  return {
    realtimeInput: {
      video: frame,
    },
  };
}

// Owns the provider socket and media; stop closes them and callbacks reject retired sockets.
export class GoogleLiveRealtimeTalkTransport implements RealtimeTalkTransport {
  private readonly gemini31LiveModel: boolean;
  private readonly completeInputTranscripts: boolean;
  private readonly extendedThinkingModel: boolean;
  private ws: WebSocket | null = null;
  private setupTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly input = this.ctx.input;
  private inputContext: AudioContext | null = null;
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  private readonly inputPump = new RealtimeTalkPcmInputPump();
  private closed = false;
  private interruptedTurn = false;
  private readonly camera: RealtimeTalkCameraOwner;
  private active = false;
  private readonly startup = Promise.withResolvers<RealtimeTalkTransportStartResult>();
  private cameraPublished = false;
  private videoFramesActive = false;
  private hasSentVideoFrame = false;
  private videoFrameTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly outputQueue = new RealtimeTalkPcmOutputQueue();
  private readonly emitTalkEvent: ReturnType<typeof createRealtimeTalkEventEmitter>;
  private readonly toolOwner: GoogleLiveToolOwner;
  private readonly pendingTranscripts = {
    user: { text: "", byteCount: 0 },
    assistant: { text: "", byteCount: 0 },
  };

  constructor(
    private readonly session: RealtimeTalkJsonPcmWebSocketSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {
    // Pinned 2.5 models retain their fragment and async tool-response contracts.
    const modelId = session.model?.replace(/^models\//, "") ?? "";
    this.gemini31LiveModel =
      !session.model || (modelId.startsWith("gemini-3.1-") && modelId.includes("-live"));
    this.completeInputTranscripts = this.gemini31LiveModel || modelId.startsWith("gemini-3.8-live");
    this.extendedThinkingModel =
      modelId.startsWith("gemini-3.8-live") && modelId.includes("extended-thinking");
    this.emitTalkEvent = createRealtimeTalkEventEmitter(ctx, session);
    this.toolOwner = new GoogleLiveToolOwner({
      ctx,
      emitTalkEvent: this.emitTalkEvent,
      isClosed: () => this.closed,
      failConnection: (detail) => this.failConnection(this.ws, detail),
      isDescribeViewActive: () =>
        this.videoFramesActive && this.hasSentVideoFrame && this.camera.hasUsableTrack(),
      sendResult: (callId, name, result) => this.sendToolResult(callId, name, result),
    });
    this.camera = new RealtimeTalkCameraOwner({
      getDeviceId: () => this.ctx.videoDeviceId,
      setDeviceId: (deviceId) => (this.ctx.videoDeviceId = deviceId),
      isClosed: () => this.closed,
      onStream: (stream) => {
        if (stream) {
          if (!this.active) {
            return;
          }
          this.cameraPublished = true;
          this.ctx.callbacks.onVideoStream?.(stream);
        } else if (this.cameraPublished) {
          this.cameraPublished = false;
          this.ctx.callbacks.onVideoStream?.(null);
        }
      },
      onAcquired: () => {
        if (this.active) {
          this.startVideoFrames();
        }
      },
      onReleased: () => this.stopVideoFrames(),
    });
  }

  async start(): Promise<RealtimeTalkTransportStartResult> {
    if (typeof WebSocket === "undefined") {
      throw new Error("Realtime Talk requires browser WebSocket and microphone access");
    }
    if (this.session.protocol !== "google-live-bidi") {
      throw new Error(`Unsupported realtime WebSocket protocol: ${this.session.protocol}`);
    }
    const wsUrl = buildGoogleLiveUrl(this.session);
    this.input.adopt((detail) => this.failConnection(this.ws, detail));
    this.inputContext = new AudioContext({ sampleRate: this.session.audio.inputSampleRateHz });
    this.outputQueue.open(this.session.audio.outputSampleRateHz);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    this.setupTimeout = globalThis.setTimeout(() => {
      if (this.closed || this.ws !== ws) {
        return;
      }
      this.setupTimeout = null;
      this.failConnection(
        ws,
        `Realtime connection timed out after ${GOOGLE_LIVE_SETUP_TIMEOUT_MS}ms`,
      );
    }, GOOGLE_LIVE_SETUP_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      if (this.closed || this.ws !== ws) {
        return;
      }
      this.send(this.session.initialMessage ?? { setup: {} });
    });
    ws.addEventListener("message", (event) => {
      this.handleMessage(ws, event.data);
    });
    ws.addEventListener("close", () => {
      this.failConnection(ws, "Realtime connection closed");
    });
    ws.addEventListener("error", () => {
      this.failConnection(ws, "Realtime connection failed");
    });
    const result = await this.startup.promise;
    return this.closed ? "cancelled" : result;
  }

  activate(): void {
    if (this.closed || this.active) {
      return;
    }
    this.active = true;
    try {
      this.ctx.callbacks.onStatus?.("listening");
      this.emitTalkEvent({ type: "session.ready" });
      if (this.ctx.callbacks.onInputLevel && this.input.stream && this.inputContext) {
        const inputMeter = new RealtimeTalkMediaStreamMeter(this.ctx.callbacks.onInputLevel);
        this.inputMeter = inputMeter;
        inputMeter.start(this.input.stream, this.inputContext);
      }
      this.startMicrophonePump();
      if (this.camera.stream && !this.cameraPublished) {
        this.cameraPublished = true;
        this.ctx.callbacks.onVideoStream?.(this.camera.stream);
      }
      this.startVideoFrames();
    } catch (error) {
      try {
        this.stop({ emitClosed: false });
      } catch {
        // Preserve the activation callback as the terminal cause after cleanup.
      }
      throw error;
    }
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    await this.camera.setEnabled(enabled);
  }

  async switchCamera(videoDeviceId: string | undefined): Promise<void> {
    await this.camera.switchDevice(videoDeviceId);
  }

  stop(options?: { emitClosed?: boolean }): void {
    const emitClosed = !this.closed && this.active && options?.emitClosed !== false;
    this.closed = true;
    this.active = false;
    this.startup.resolve("cancelled");
    try {
      if (emitClosed) {
        this.emitTalkEvent({ type: "session.closed", final: true });
      }
    } finally {
      this.releaseResources();
    }
  }

  private releaseResources(): void {
    this.clearSetupTimeout();
    this.interruptedTurn = false;
    this.pendingTranscripts.user = { text: "", byteCount: 0 };
    this.pendingTranscripts.assistant = { text: "", byteCount: 0 };
    this.input.stop();
    this.toolOwner.release();
    this.inputPump.stop();
    this.outputQueue.close();
    void this.inputContext?.close();
    this.inputContext = null;
    this.ws?.close();
    this.ws = null;
    // Release capture and native resources before notifying presentation callbacks.
    this.camera.release();
    const inputMeter = this.inputMeter;
    this.inputMeter = null;
    inputMeter?.stop();
  }

  private clearSetupTimeout(): void {
    if (this.setupTimeout !== null) {
      globalThis.clearTimeout(this.setupTimeout);
      this.setupTimeout = null;
    }
  }

  private failConnection(ws: WebSocket | null, detail: string): void {
    // Error and close can arrive for the same socket, or after a replacement
    // starts. Only the current lifecycle owner may report and release resources.
    if (this.closed || !ws || this.ws !== ws) {
      return;
    }
    if (!this.active) {
      this.startup.reject(new Error(detail));
      try {
        this.stop({ emitClosed: false });
      } catch {
        // Preserve the startup rejection after releasing capture.
      }
      return;
    }
    try {
      this.ctx.callbacks.onStatus?.("error", detail);
    } finally {
      // Socket failure is terminal even when a consumer callback rejects the update.
      this.stop();
    }
  }

  private startMicrophonePump(): void {
    if (this.closed || !this.input.stream || !this.inputContext) {
      return;
    }
    this.inputPump.start(this.input.stream, this.inputContext, (samples) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        return;
      }
      const pcm = floatToPcm16(samples);
      this.send({
        realtimeInput: {
          audio: {
            data: bytesToBase64(pcm),
            mimeType: `audio/pcm;rate=${this.inputContext?.sampleRate ?? 16000}`,
          },
        },
      });
    });
  }

  private send(message: unknown): boolean {
    if (!this.closed && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  private handleMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    if (this.closed || this.ws !== ws) {
      return;
    }
    let message: GoogleLiveMessage;
    try {
      message = JSON.parse(
        typeof data === "string" ? data : new TextDecoder().decode(data),
      ) as GoogleLiveMessage;
    } catch {
      return;
    }
    if (message.setupComplete) {
      this.startup.resolve("ready");
      this.clearSetupTimeout();
    }
    // The parent session adopts the candidate after start() resolves. Provider
    // events remain provisional until activate() publishes that ownership.
    if (!this.active) {
      return;
    }
    const content = message.serverContent;
    if (content?.interrupted) {
      this.interruptedTurn = true;
      this.outputQueue.stop();
    }
    if (content?.inputTranscription && !this.appendTranscript("user", content.inputTranscription)) {
      return;
    }
    // The configured output transcription owns spoken text; modelTurn text has
    // no transcript identity and must not create a second history entry.
    if (
      content?.outputTranscription &&
      !this.appendTranscript("assistant", content.outputTranscription)
    ) {
      return;
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.emitTalkEvent({
          type: "output.audio.delta",
          payload: {
            byteLength: estimateBase64DecodedByteLength(part.inlineData.data),
            mimeType: part.inlineData.mimeType,
          },
        });
        if (this.closed) {
          return;
        }
        this.playPcm16(part.inlineData.data);
        if (this.closed) {
          return;
        }
      }
    }
    // Output transcription precedes model completion/interruption. Publish its
    // final before ending the Talk turn, which releases that turn's event identity.
    if (content?.generationComplete || content?.interrupted || content?.turnComplete) {
      if (!this.flushTranscript("assistant")) {
        return;
      }
    }
    if (content?.interrupted) {
      this.emitTalkEvent({
        type: "turn.cancelled",
        final: true,
        payload: { reason: "provider-interrupted" },
      });
    } else if (
      content?.turnComplete &&
      !this.interruptedTurn &&
      (!this.extendedThinkingModel || content.interactionStatus === "IDLE")
    ) {
      this.emitTalkEvent({ type: "turn.ended", final: true });
    }
    // Every turnComplete finalizes that spoken utterance above. Extended Thinking filler
    // remains IN_PROGRESS, so it does not end the overall Talk turn until IDLE. Google
    // completes interrupted turns separately; their cancellation remains terminal even if
    // the accompanying interaction status is not IDLE.
    if (content?.turnComplete) {
      this.interruptedTurn = false;
    }
    if (this.closed) {
      return;
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      void this.toolOwner.handleCall(call).catch((error: unknown) => {
        this.reportToolResultSubmissionError(error);
      });
    }
    this.toolOwner.cancel(message.toolCallCancellation?.ids);
  }

  private appendTranscript(
    role: "user" | "assistant",
    transcript: { text?: string; finished?: boolean },
  ): boolean {
    const pending = this.pendingTranscripts[role];
    // Live 3.1 and 3.8 send complete input utterances without a finished flag.
    const completeInput = role === "user" && this.completeInputTranscripts;
    if (transcript.text) {
      pending.byteCount += utf8Encoder.encode(transcript.text).byteLength;
      if (pending.byteCount > GOOGLE_LIVE_MAX_TRANSCRIPT_BYTES) {
        this.failConnection(
          this.ws,
          "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit",
        );
        return false;
      }
      pending.text += transcript.text;
      if (!completeInput && !this.emitTranscript(role, transcript.text, false)) {
        return false;
      }
    }
    return transcript.finished || completeInput ? this.flushTranscript(role) : !this.closed;
  }

  private flushTranscript(role: "user" | "assistant"): boolean {
    const text = this.pendingTranscripts[role].text.trim();
    this.pendingTranscripts[role] = { text: "", byteCount: 0 };
    return text ? this.emitTranscript(role, text, true) : !this.closed;
  }

  private emitTranscript(role: "user" | "assistant", text: string, final: boolean): boolean {
    this.ctx.callbacks.onTranscript?.({ role, text, final });
    if (this.closed) {
      return false;
    }
    this.emitTalkEvent({
      type:
        role === "user"
          ? final
            ? "transcript.done"
            : "transcript.delta"
          : final
            ? "output.text.done"
            : "output.text.delta",
      final,
      payload: role === "user" ? { role, text } : { text },
    });
    if (
      !this.closed &&
      role === "user" &&
      final &&
      this.toolOwner.hasPendingConsult() &&
      shouldAutoControlRealtimeVoiceAgentText(text)
    ) {
      void steerRealtimeTalkActiveConsult({
        ctx: this.ctx,
        text,
        emitTalkEvent: this.emitTalkEvent,
        onControlResult: (result) => {
          if (shouldInterruptRealtimeTalkControlResponse(result)) {
            this.outputQueue.stop();
          }
        },
        speakControlResult: (message) => this.sendControlSpeechMessage(message),
        suppressSpeechForModes: ["cancel"],
      });
    }
    return !this.closed;
  }

  private playPcm16(base64: string): void {
    if (this.closed) {
      return;
    }
    const result = this.outputQueue.play(base64);
    if (result !== "overflow") {
      return;
    }
    this.outputQueue.stop();
    this.emitTalkEvent({
      type: "turn.cancelled",
      final: true,
      payload: { reason: "playback-overflow" },
    });
    this.ctx.callbacks.onStatus?.(
      "error",
      "Realtime Talk playback exceeded the browser audio buffer limit",
    );
    // Google Live exposes server-driven interruption but no client response-cancel
    // frame, so closing the session is the only deterministic provider-side stop.
    this.stop();
  }

  private sendToolResult(callId: string, name: string, result: unknown): void {
    const sent = this.send({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name,
            // Extended Thinking rejects scheduled responses; plain 3.8 retains them.
            ...(!this.gemini31LiveModel && !this.extendedThinkingModel
              ? { scheduling: "WHEN_IDLE" }
              : {}),
            response:
              result && typeof result === "object" && !Array.isArray(result)
                ? result
                : { output: result },
          },
        ],
      },
    });
    if (!sent) {
      throw new Error("Google Live socket is not open");
    }
  }

  private reportToolResultSubmissionError(error: unknown): void {
    if (this.closed) {
      return;
    }
    const message = formatUiError(error);
    this.ctx.callbacks.onStatus?.("error", message);
  }

  private startVideoFrames(): void {
    if (!this.camera.video || this.videoFramesActive || this.closed) {
      return;
    }
    this.videoFramesActive = true;
    this.scheduleVideoFrame(0);
  }

  private scheduleVideoFrame(delayMs: number): void {
    if (!this.videoFramesActive || this.closed) {
      return;
    }
    this.videoFrameTimer = globalThis.setTimeout(() => {
      this.videoFrameTimer = null;
      void this.sendVideoFrame();
    }, delayMs);
  }

  private async sendVideoFrame(): Promise<void> {
    const video = this.camera.video;
    if (!this.camera.hasLiveTrack()) {
      this.stopVideoFrames();
      return;
    }
    if (!this.camera.hasUsableTrack()) {
      this.scheduleVideoFrame(GOOGLE_LIVE_VIDEO_FRAME_INTERVAL_MS);
      return;
    }
    try {
      const frame = await captureRealtimeTalkVideoFrame(
        video,
        GOOGLE_LIVE_VIDEO_MESSAGE_MAX_BYTES,
        googleLiveVideoMessage,
      );
      if (!this.videoFramesActive || this.closed || this.camera.video !== video) {
        return;
      }
      // Keep polling through a mute that occurs while preview data becomes ready.
      if (this.camera.hasUsableTrack()) {
        if (!this.send(googleLiveVideoMessage(frame))) {
          throw new Error("Google Live socket is not open");
        }
        this.hasSentVideoFrame = true;
      }
    } catch (error) {
      if (!this.closed && this.camera.video === video) {
        this.videoFramesActive = false;
        this.reportToolResultSubmissionError(error);
      }
      return;
    }
    if (this.camera.video === video) {
      this.scheduleVideoFrame(GOOGLE_LIVE_VIDEO_FRAME_INTERVAL_MS);
    }
  }

  private stopVideoFrames(): void {
    this.videoFramesActive = false;
    this.hasSentVideoFrame = false;
    if (this.videoFrameTimer !== null) {
      globalThis.clearTimeout(this.videoFrameTimer);
      this.videoFrameTimer = null;
    }
  }

  private sendControlSpeechMessage(message: string): void {
    this.outputQueue.stop();
    this.send(
      this.gemini31LiveModel
        ? { realtimeInput: { text: message } }
        : {
            clientContent: {
              turns: [{ role: "user", parts: [{ text: message }] }],
              turnComplete: true,
            },
          },
    );
  }
}
