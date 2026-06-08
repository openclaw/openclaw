// Control UI chat module implements xAI realtime Talk websocket behavior.
import { base64ToBytes, bytesToBase64, floatToPcm16 } from "./realtime-talk-audio.ts";
import { RealtimeTalkPcmOutputQueue } from "./realtime-talk-pcm-output.ts";
import type { RealtimeTalkJsonPcmWebSocketSessionResult } from "./realtime-talk-shared.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  createRealtimeTalkEventEmitter,
  steerRealtimeTalkActiveConsult,
  shouldAutoControlRealtimeVoiceAgentText,
  submitRealtimeTalkAgentControl,
  submitRealtimeTalkConsult,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";

type XaiRealtimeEvent = {
  type?: string;
  delta?: string;
  data?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  error?: unknown;
};

type PendingFunctionCall = {
  name: string;
  args: unknown;
};

const XAI_TOOL_CONTINUATION_PLAYBACK_SETTLE_MS = 50;
const XAI_REALTIME_WEBSOCKET_HOST = "api.x.ai";
const XAI_REALTIME_WEBSOCKET_PATH = "/v1/realtime";
const XAI_REALTIME_PROTOCOL = "xai-realtime";

export function buildXaiRealtimeUrl(session: RealtimeTalkJsonPcmWebSocketSessionResult): string {
  let url: URL;
  try {
    url = new URL(session.websocketUrl);
  } catch {
    throw new Error("Invalid xAI Realtime WebSocket URL");
  }
  if (url.protocol !== "wss:") {
    throw new Error("xAI Realtime WebSocket URL must use wss://");
  }
  if (url.hostname.toLowerCase() !== XAI_REALTIME_WEBSOCKET_HOST) {
    throw new Error("Untrusted xAI Realtime WebSocket host");
  }
  if (url.username || url.password) {
    throw new Error("xAI Realtime WebSocket URL must not include credentials");
  }
  if (url.pathname !== XAI_REALTIME_WEBSOCKET_PATH) {
    throw new Error("Untrusted xAI Realtime WebSocket path");
  }
  return url.toString();
}

export class XaiRealtimeTalkTransport implements RealtimeTalkTransport {
  private ws: WebSocket | null = null;
  private media: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputProcessor: ScriptProcessorNode | null = null;
  private closed = false;
  private outputStarted = false;
  private pendingCallArgs = new Map<string, { name: string; callId: string; args: string }>();
  private pendingCalls = new Map<string, PendingFunctionCall>();
  private deliveredToolCallKeys = new Set<string>();
  private toolCallBatchOpen = false;
  private responseCreatePending = false;
  private responseCreateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly consultAbortControllers = new Set<AbortController>();
  private readonly outputQueue = new RealtimeTalkPcmOutputQueue();
  private readonly emitTalkEvent: ReturnType<typeof createRealtimeTalkEventEmitter>;

  constructor(
    private readonly session: RealtimeTalkJsonPcmWebSocketSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {
    this.emitTalkEvent = createRealtimeTalkEventEmitter(ctx, session);
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof WebSocket === "undefined") {
      throw new Error("Realtime Talk requires browser WebSocket and microphone access");
    }
    if (this.session.protocol !== XAI_REALTIME_PROTOCOL) {
      throw new Error(`Unsupported realtime WebSocket protocol: ${this.session.protocol}`);
    }
    if (
      this.session.audio.inputEncoding !== "pcm16" ||
      this.session.audio.outputEncoding !== "pcm16"
    ) {
      throw new Error("xAI Realtime Talk currently requires PCM16 audio");
    }
    const wsUrl = buildXaiRealtimeUrl(this.session);
    this.closed = false;
    this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.inputContext = new AudioContext({ sampleRate: this.session.audio.inputSampleRateHz });
    this.outputContext = new AudioContext({ sampleRate: this.session.audio.outputSampleRateHz });
    this.ws = new WebSocket(wsUrl, `xai-client-secret.${this.session.clientSecret}`);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      if (this.closed) {
        return;
      }
      this.send(this.session.initialMessage ?? { type: "session.update", session: {} });
      this.startMicrophonePump();
    });
    this.ws.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    this.ws.addEventListener("close", () => {
      if (!this.closed) {
        this.ctx.callbacks.onStatus?.("error", "Realtime connection closed");
      }
    });
    this.ws.addEventListener("error", () => {
      if (!this.closed) {
        this.ctx.callbacks.onStatus?.("error", "Realtime connection failed");
      }
    });
  }

  stop(): void {
    if (!this.closed) {
      this.emitTalkEvent({ type: "session.closed", final: true });
    }
    this.closed = true;
    for (const controller of this.consultAbortControllers) {
      controller.abort();
    }
    this.consultAbortControllers.clear();
    this.pendingCallArgs.clear();
    this.pendingCalls.clear();
    this.deliveredToolCallKeys.clear();
    this.toolCallBatchOpen = false;
    this.clearPendingResponseCreate();
    this.inputProcessor?.disconnect();
    this.inputProcessor = null;
    this.inputSource?.disconnect();
    this.inputSource = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.stopOutput();
    void this.inputContext?.close();
    this.inputContext = null;
    void this.outputContext?.close();
    this.outputContext = null;
    this.ws?.close();
    this.ws = null;
  }

  private startMicrophonePump(): void {
    if (this.closed || !this.media || !this.inputContext) {
      return;
    }
    this.inputSource = this.inputContext.createMediaStreamSource(this.media);
    this.inputProcessor = this.inputContext.createScriptProcessor(4096, 1, 1);
    this.inputProcessor.onaudioprocess = (event) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        return;
      }
      const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
      this.send({
        type: "input_audio_buffer.append",
        audio: bytesToBase64(pcm),
      });
    };
    this.inputSource.connect(this.inputProcessor);
    this.inputProcessor.connect(this.inputContext.destination);
  }

  private send(message: unknown): void {
    if (!this.closed && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (this.closed) {
      return;
    }
    let event: XaiRealtimeEvent;
    try {
      event = JSON.parse(await decodeXaiRealtimeMessageData(data)) as XaiRealtimeEvent;
    } catch {
      return;
    }
    if (this.closed) {
      return;
    }
    switch (event.type) {
      case "session.updated":
        this.ctx.callbacks.onStatus?.("listening");
        this.emitTalkEvent({ type: "session.ready" });
        return;
      case "input_audio_buffer.speech_started":
        this.stopOutput();
        this.emitTalkEvent({ type: "turn.started", payload: { source: event.type } });
        return;
      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed":
        this.emitTalkEvent({ type: "input.audio.committed", final: true });
        return;
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.delta":
        this.emitTranscript("user", event.transcript ?? event.text ?? event.delta, false);
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.emitTranscript("user", event.transcript ?? event.text ?? event.delta, true);
        return;
      case "conversation.output_transcript.delta":
      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        this.emitTranscript("assistant", event.delta ?? event.text ?? event.transcript, false);
        return;
      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        this.emitTranscript("assistant", event.transcript ?? event.text ?? event.delta, true);
        return;
      case "conversation.output_audio.delta":
      case "response.audio.delta":
      case "response.output_audio.delta":
        this.handleAudioDelta(event.delta ?? event.data);
        return;
      case "response.output_audio.done":
      case "response.audio.done":
        this.outputStarted = false;
        this.emitTalkEvent({ type: "output.audio.done", final: true });
        return;
      case "response.function_call_arguments.delta":
        this.bufferFunctionCallArgs(event);
        return;
      case "response.function_call_arguments.done":
        void this.handleFunctionCallDone(event);
        return;
      case "response.output_item.done":
      case "conversation.item.done":
        void this.handleOutputItemDone(event);
        return;
      case "response.cancelled":
        this.toolCallBatchOpen = false;
        this.clearPendingResponseCreate();
        this.stopOutput();
        this.emitTalkEvent({
          type: "turn.cancelled",
          final: true,
          payload: { reason: "provider-cancelled" },
        });
        return;
      case "response.done":
        this.toolCallBatchOpen = false;
        this.outputStarted = false;
        this.emitTalkEvent({ type: "turn.ended", final: true });
        this.flushPendingResponseCreate();
        return;
      case "error":
        this.ctx.callbacks.onStatus?.("error", readXaiRealtimeErrorDetail(event.error));
      default:
    }
  }

  private emitTranscript(role: "user" | "assistant", text: string | undefined, final: boolean) {
    if (!text) {
      return;
    }
    this.ctx.callbacks.onTranscript?.({ role, text, final });
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
      role === "user" &&
      final &&
      this.consultAbortControllers.size > 0 &&
      shouldAutoControlRealtimeVoiceAgentText(text)
    ) {
      void steerRealtimeTalkActiveConsult({
        ctx: this.createActiveContext(),
        text,
        emitTalkEvent: this.emitTalkEvent,
        onControlResult: (result) => this.stopOutputForSuppressedControl(result),
        speakControlResult: (message) => this.sendControlSpeechMessage(message),
        suppressSpeechForModes: ["cancel"],
      });
    }
  }

  private handleAudioDelta(delta: string | undefined): void {
    if (!delta) {
      return;
    }
    if (!this.outputStarted) {
      this.outputStarted = true;
      this.emitTalkEvent({ type: "output.audio.started" });
    }
    this.emitTalkEvent({
      type: "output.audio.delta",
      payload: {
        byteLength: base64ToBytes(delta).byteLength,
        mimeType: `audio/pcm;rate=${this.session.audio.outputSampleRateHz}`,
      },
    });
    this.outputQueue.play(delta, this.outputContext, this.session.audio.outputSampleRateHz);
  }

  private stopOutput(): void {
    this.outputStarted = false;
    this.outputQueue.stop(this.outputContext);
  }

  private bufferFunctionCallArgs(event: XaiRealtimeEvent): void {
    const key = event.item_id ?? event.call_id;
    if (!key) {
      return;
    }
    const existing = this.pendingCallArgs.get(key);
    if (existing) {
      existing.args += event.delta ?? "";
      if (event.name) {
        existing.name = event.name;
      }
      if (event.call_id) {
        existing.callId = event.call_id;
      }
      return;
    }
    this.pendingCallArgs.set(key, {
      name: event.name ?? "",
      callId: event.call_id ?? key,
      args: event.delta ?? "",
    });
  }

  private async handleFunctionCallDone(event: XaiRealtimeEvent): Promise<void> {
    const key = event.item_id ?? event.call_id;
    const buffered = key ? this.pendingCallArgs.get(key) : undefined;
    if (key) {
      this.pendingCallArgs.delete(key);
    }
    await this.handleToolCall({
      itemId: event.item_id,
      callId: buffered?.callId || event.call_id,
      name: buffered?.name || event.name,
      rawArgs: buffered?.args || event.arguments,
    });
  }

  private async handleOutputItemDone(event: XaiRealtimeEvent): Promise<void> {
    if (event.item?.type !== "function_call") {
      return;
    }
    await this.handleToolCall({
      itemId: event.item.id ?? event.item_id,
      callId: event.item.call_id ?? event.call_id ?? event.item.id ?? event.item_id,
      name: event.item.name ?? event.name,
      rawArgs: event.item.arguments ?? event.arguments,
    });
  }

  private async handleToolCall(fields: {
    itemId?: string;
    callId?: string;
    name?: string;
    rawArgs?: string;
  }): Promise<void> {
    const name = fields.name?.trim();
    const callId = fields.callId?.trim() || fields.itemId?.trim();
    if (!name || !callId) {
      return;
    }
    const dedupeKey = fields.itemId || fields.callId || `${name}:${fields.rawArgs ?? ""}`;
    if (this.deliveredToolCallKeys.has(dedupeKey)) {
      return;
    }
    this.deliveredToolCallKeys.add(dedupeKey);
    let args: unknown = {};
    try {
      args = JSON.parse(fields.rawArgs || "{}");
    } catch {}
    this.pendingCalls.set(callId, { name, args });
    this.toolCallBatchOpen = true;
    this.emitTalkEvent({ type: "tool.call", callId, payload: { name, args } });
    if (name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      await submitRealtimeTalkAgentControl({
        ctx: this.createActiveContext(),
        callId,
        args,
        emitTalkEvent: this.emitTalkEvent,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
      return;
    }
    if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      this.submitToolResult(callId, { error: `Tool "${name}" not available in browser Talk` });
      return;
    }
    const abortController = new AbortController();
    this.consultAbortControllers.add(abortController);
    try {
      await submitRealtimeTalkConsult({
        ctx: this.createActiveContext(),
        callId,
        args,
        signal: abortController.signal,
        emitTalkEvent: this.emitTalkEvent,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
    } finally {
      this.consultAbortControllers.delete(abortController);
    }
  }

  private createActiveContext(): RealtimeTalkTransportContext {
    return {
      ...this.ctx,
      callbacks: {
        onStatus: (status, detail) => {
          if (!this.closed) {
            this.ctx.callbacks.onStatus?.(status, detail);
          }
        },
        onTranscript: (entry) => {
          if (!this.closed) {
            this.ctx.callbacks.onTranscript?.(entry);
          }
        },
        onTalkEvent: (event) => {
          if (!this.closed) {
            this.ctx.callbacks.onTalkEvent?.(event);
          }
        },
      },
    };
  }

  private submitToolResult(callId: string, result: unknown): void {
    const pending = this.pendingCalls.get(callId);
    if (!pending) {
      return;
    }
    this.pendingCalls.delete(callId);
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(
          result && typeof result === "object" && !Array.isArray(result)
            ? result
            : { output: result },
        ),
      },
    });
    this.requestResponseCreate();
  }

  private sendControlSpeechMessage(message: string): void {
    this.stopOutput();
    this.send({
      type: "conversation.item.create",
      item: {
        type: "force_message",
        role: "assistant",
        interruptible: true,
        content: [{ type: "output_text", text: message.trim() }],
      },
    });
  }

  private stopOutputForSuppressedControl(result: unknown): void {
    if (!result || typeof result !== "object") {
      return;
    }
    const record = result as Record<string, unknown>;
    if (
      record.ok === true &&
      (record.mode === "cancel" || (record.suppress === true && record.mode !== "steer"))
    ) {
      this.stopOutput();
    }
  }

  private requestResponseCreate(): void {
    this.responseCreatePending = true;
    this.flushPendingResponseCreate();
  }

  private flushPendingResponseCreate(): void {
    if (!this.responseCreatePending || this.closed) {
      return;
    }
    if (this.toolCallBatchOpen || this.pendingCalls.size > 0) {
      return;
    }
    const delayMs = this.responseCreatePlaybackDelayMs();
    if (delayMs > 0) {
      this.scheduleResponseCreate(delayMs);
      return;
    }
    this.clearResponseCreateTimer();
    this.responseCreatePending = false;
    this.send({ type: "response.create" });
  }

  private responseCreatePlaybackDelayMs(): number {
    const currentTime = this.outputContext?.currentTime ?? 0;
    const queuedUntil = this.outputQueue.queuedUntil || currentTime;
    const remainingMs = Math.ceil(Math.max(0, (queuedUntil - currentTime) * 1000));
    return Math.max(0, remainingMs - XAI_TOOL_CONTINUATION_PLAYBACK_SETTLE_MS);
  }

  private scheduleResponseCreate(delayMs: number): void {
    this.clearResponseCreateTimer();
    this.responseCreateTimer = setTimeout(() => {
      this.responseCreateTimer = null;
      this.flushPendingResponseCreate();
    }, delayMs);
  }

  private clearPendingResponseCreate(): void {
    this.responseCreatePending = false;
    this.clearResponseCreateTimer();
  }

  private clearResponseCreateTimer(): void {
    if (this.responseCreateTimer === null) {
      return;
    }
    clearTimeout(this.responseCreateTimer);
    this.responseCreateTimer = null;
  }
}

async function decodeXaiRealtimeMessageData(dataInput: unknown): Promise<string> {
  let data = dataInput;
  if (typeof data === "string") {
    return data;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    data = await data.arrayBuffer();
  }
  if (isArrayBufferLike(data)) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return String(data);
}

function isArrayBufferLike(data: unknown): data is ArrayBuffer {
  return (
    data instanceof ArrayBuffer || Object.prototype.toString.call(data) === "[object ArrayBuffer]"
  );
}

function readXaiRealtimeErrorDetail(error: unknown): string {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return "xAI Realtime connection failed";
}
