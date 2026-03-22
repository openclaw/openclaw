import WebSocket from "ws";
import {
  REALTIME_AUDIO_SAMPLE_RATE,
  base64ToBuffer,
  bufferToBase64,
  resamplePcm16Mono,
} from "./audio.js";

type AudioSessionCallbacks = {
  onOutputAudioDelta?: (audioBase64: string) => void;
  onOutputTranscriptDelta?: (text: string) => void;
  onSpeechStarted?: () => void;
  onError?: (error: Error) => void;
};

export type RealtimeFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

type PendingToolCall = {
  callId: string;
  name?: string;
  argumentsBuffer: string;
};

type AudioSessionOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  instructions: string;
  tools?: RealtimeFunctionTool[];
  onToolCall?: (params: {
    name: string;
    argumentsJson: string;
    callId: string;
  }) => Promise<unknown>;
  callbacks?: AudioSessionCallbacks;
};

type RealtimeServerEvent =
  | { type: "session.created" }
  | { type: "session.updated" }
  | { type: "response.created" }
  | { type: "response.done" }
  | { type: "response.failed" }
  | { type: "response.cancelled" }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  | { type: "response.output_item.done"; item?: Record<string, unknown> }
  | { type: "response.function_call_arguments.delta"; call_id?: string; delta?: string }
  | {
      type: "response.function_call_arguments.done";
      call_id?: string;
      arguments?: string;
      name?: string;
    }
  | { type: "response.output_audio.delta"; delta?: string }
  | { type: "response.output_audio.done" }
  | { type: "response.output_audio_transcript.delta"; delta?: string }
  | { type: "response.output_audio_transcript.done"; transcript?: string }
  | { type: "error"; error?: { message?: string } };

function buildRealtimeWsUrl(baseUrl: string, model: string): string {
  return `${baseUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    .replace(/\/+$/, "")}/realtime?model=${encodeURIComponent(model)}`;
}

function rawDataToUtf8(raw: WebSocket.RawData): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  return null;
}

export class AzureRealtimeAudioSession {
  private socket: WebSocket | null = null;
  private callbacks: AudioSessionCallbacks;
  private closed = false;
  private outputAudioBuffer = Buffer.alloc(0);
  private outputFlushTimer: NodeJS.Timeout | null = null;
  private pendingInstructions: string;
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private readonly dispatchedToolCallIds = new Set<string>();
  private responseInProgress = false;
  private queuedResponseCreate = false;

  constructor(private readonly options: AudioSessionOptions) {
    this.callbacks = options.callbacks ?? {};
    this.pendingInstructions = options.instructions;
  }

  setCallbacks(callbacks: AudioSessionCallbacks): void {
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    const url = buildRealtimeWsUrl(this.options.baseUrl, this.options.model);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          "api-key": this.options.apiKey,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.socket = socket;

      const onOpen = () => resolve();
      const onError = (error: Error) => reject(error);

      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.on("message", (raw) => this.handleEvent(raw));
      socket.on("close", () => {
        this.flushOutputAudio();
        this.socket = null;
      });
    });
  }

  updateInstructions(instructions: string): void {
    this.pendingInstructions = instructions;
    this.sendSessionUpdate();
  }

  appendInputAudio(audioBase64: string, sampleRate: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    let audioBuffer = base64ToBuffer(audioBase64);
    if (sampleRate !== REALTIME_AUDIO_SAMPLE_RATE) {
      audioBuffer = resamplePcm16Mono(audioBuffer, sampleRate, REALTIME_AUDIO_SAMPLE_RATE);
    }
    if (audioBuffer.length === 0) {
      return;
    }
    this.send({
      type: "input_audio_buffer.append",
      audio: bufferToBase64(audioBuffer),
    });
  }

  close(): void {
    this.closed = true;
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      try {
        this.socket.close();
      } catch {
        // Ignore close errors.
      }
    }
    this.socket = null;
  }

  private handleEvent(raw: WebSocket.RawData): void {
    let event: RealtimeServerEvent;
    const payload = rawDataToUtf8(raw);
    if (!payload) {
      return;
    }
    try {
      event = JSON.parse(payload) as RealtimeServerEvent;
    } catch {
      return;
    }

    if (event.type === "session.created") {
      this.sendSessionUpdate();
      return;
    }

    if (event.type === "response.created") {
      this.responseInProgress = true;
      return;
    }

    if (
      event.type === "response.done" ||
      event.type === "response.failed" ||
      event.type === "response.cancelled"
    ) {
      this.responseInProgress = false;
      if (this.queuedResponseCreate) {
        this.queuedResponseCreate = false;
        this.requestResponseCreate();
      }
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      this.callbacks.onSpeechStarted?.();
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      return;
    }

    if (
      event.type === "response.function_call_arguments.delta" &&
      typeof event.call_id === "string"
    ) {
      const current = this.pendingToolCalls.get(event.call_id) ?? {
        callId: event.call_id,
        argumentsBuffer: "",
      };
      if (typeof event.delta === "string") {
        current.argumentsBuffer += event.delta;
      }
      this.pendingToolCalls.set(event.call_id, current);
      return;
    }

    if (
      event.type === "response.function_call_arguments.done" &&
      typeof event.call_id === "string"
    ) {
      const current = this.pendingToolCalls.get(event.call_id) ?? {
        callId: event.call_id,
        argumentsBuffer: "",
      };
      if (typeof event.arguments === "string" && event.arguments.trim()) {
        current.argumentsBuffer = event.arguments;
      }
      if (typeof event.name === "string" && event.name.trim()) {
        current.name = event.name.trim();
      }
      this.pendingToolCalls.set(event.call_id, current);
      this.dispatchToolCall({
        callId: event.call_id,
        name: current.name,
        argumentsJson: current.argumentsBuffer || "{}",
      });
      return;
    }

    if (
      event.type === "response.output_item.done" &&
      event.item &&
      typeof event.item === "object"
    ) {
      const item = event.item as {
        type?: unknown;
        call_id?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (item.type === "function_call" && typeof item.call_id === "string") {
        const argumentsJson =
          typeof item.arguments === "string" && item.arguments.trim() ? item.arguments : "{}";
        const name = typeof item.name === "string" && item.name.trim() ? item.name : undefined;
        this.dispatchToolCall({
          callId: item.call_id,
          name,
          argumentsJson,
        });
      }
      return;
    }

    if (event.type === "response.output_audio.delta" && typeof event.delta === "string") {
      this.outputAudioBuffer = Buffer.concat([this.outputAudioBuffer, base64ToBuffer(event.delta)]);
      this.scheduleOutputFlush();
      return;
    }

    if (event.type === "response.output_audio.done") {
      this.flushOutputAudio();
      return;
    }

    if (
      event.type === "response.output_audio_transcript.delta" &&
      typeof event.delta === "string"
    ) {
      this.callbacks.onOutputTranscriptDelta?.(event.delta);
      return;
    }

    if (
      event.type === "response.output_audio_transcript.done" &&
      typeof event.transcript === "string"
    ) {
      this.callbacks.onOutputTranscriptDelta?.(`\n${event.transcript}\n`);
      return;
    }

    if (event.type === "error") {
      const message =
        event.error?.message || `Azure realtime audio session failed for ${this.options.model}`;
      if (message.toLowerCase().includes("active response in progress")) {
        this.responseInProgress = true;
        this.queuedResponseCreate = true;
      }
      this.callbacks.onError?.(new Error(message));
    }
  }

  private sendSessionUpdate(): void {
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: this.pendingInstructions,
        output_modalities: ["audio"],
        ...(this.options.tools && this.options.tools.length > 0
          ? { tools: this.options.tools }
          : {}),
        ...(this.options.tools && this.options.tools.length > 0 ? { tool_choice: "auto" } : {}),
        audio: {
          input: {
            format: { type: "audio/pcm", rate: REALTIME_AUDIO_SAMPLE_RATE },
            transcription: {
              model: "gpt-4o-transcribe",
            },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
              prefix_padding_ms: 500,
              silence_duration_ms: 350,
              threshold: 0.2,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: REALTIME_AUDIO_SAMPLE_RATE },
            voice: "marin",
          },
        },
      },
    });
  }

  private dispatchToolCall(params: { callId: string; name?: string; argumentsJson: string }): void {
    if (this.dispatchedToolCallIds.has(params.callId)) {
      return;
    }
    const name = params.name?.trim();
    if (!name) {
      return;
    }
    this.dispatchedToolCallIds.add(params.callId);
    this.pendingToolCalls.delete(params.callId);
    if (!this.options.onToolCall) {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: params.callId,
          output: JSON.stringify({ ok: false, error: "No tool handler configured" }),
        },
      });
      this.requestResponseCreate();
      return;
    }
    void this.options
      .onToolCall({
        name,
        argumentsJson: params.argumentsJson,
        callId: params.callId,
      })
      .then((result) => {
        this.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: params.callId,
            output: JSON.stringify({ ok: true, result }),
          },
        });
        this.requestResponseCreate();
      })
      .catch((error) => {
        this.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: params.callId,
            output: JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        });
        this.requestResponseCreate();
      });
  }

  private requestResponseCreate(): void {
    if (this.responseInProgress) {
      this.queuedResponseCreate = true;
      return;
    }
    this.responseInProgress = true;
    this.send({ type: "response.create" });
  }

  private scheduleOutputFlush(): void {
    if (this.outputFlushTimer) {
      return;
    }
    this.outputFlushTimer = setTimeout(() => {
      this.outputFlushTimer = null;
      this.flushOutputAudio();
    }, 200);
    this.outputFlushTimer.unref?.();
  }

  private flushOutputAudio(): void {
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }
    if (this.outputAudioBuffer.length === 0) {
      return;
    }
    const chunk = this.outputAudioBuffer;
    this.outputAudioBuffer = Buffer.alloc(0);
    this.callbacks.onOutputAudioDelta?.(bufferToBase64(chunk));
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.closed) {
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }
}
