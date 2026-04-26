import {
  buildRealtimeVoiceAgentConsultChatMessage,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
} from "../../../../src/realtime-voice/agent-consult-tool.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway.ts";
import { generateUUID } from "../uuid.ts";

export type RealtimeTalkStatus = "idle" | "connecting" | "listening" | "thinking" | "error";

export type RealtimeTalkCallbacks = {
  onStatus?: (status: RealtimeTalkStatus, detail?: string) => void;
  onTranscript?: (entry: { role: "user" | "assistant"; text: string; final: boolean }) => void;
};

export type RealtimeTalkSessionResult = {
  provider: string;
  clientSecret: string;
  transport?: "openai-webrtc" | "google-live-websocket";
  model?: string;
  voice?: string;
  expiresAt?: number;
  websocketUrl?: string;
  googleLiveSetup?: Record<string, unknown>;
};

type RealtimeServerEvent = {
  type?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  delta?: string;
  transcript?: string;
  arguments?: string;
};

type ToolBuffer = {
  name: string;
  callId: string;
  args: string;
};

type ChatPayload = {
  runId?: string;
  state?: string;
  errorMessage?: string;
  message?: unknown;
};

type GoogleLiveServerMessage = {
  setupComplete?: unknown;
  serverContent?: {
    interrupted?: boolean;
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string; finished?: boolean };
    turnComplete?: boolean;
    modelTurn?: {
      parts?: Array<{
        inlineData?: { data?: string; mimeType?: string };
        text?: string;
        thought?: boolean;
      }>;
    };
  };
  toolCall?: {
    functionCalls?: Array<{
      id?: string;
      name?: string;
      args?: unknown;
    }>;
  };
};

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const entry = block as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

function waitForChatResult(params: {
  client: GatewayBrowserClient;
  runId: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("OpenClaw tool call timed out"));
    }, params.timeoutMs);
    const unsubscribe = params.client.addEventListener((evt: GatewayEventFrame) => {
      if (evt.event !== "chat") {
        return;
      }
      const payload = evt.payload as ChatPayload | undefined;
      if (!payload || payload.runId !== params.runId) {
        return;
      }
      if (payload.state === "final") {
        window.clearTimeout(timer);
        unsubscribe();
        resolve(extractTextFromMessage(payload.message) || "OpenClaw finished with no text.");
      } else if (payload.state === "error") {
        window.clearTimeout(timer);
        unsubscribe();
        reject(new Error(payload.errorMessage ?? "OpenClaw tool call failed"));
      }
    });
  });
}

export class RealtimeTalkSession {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private googleWs: WebSocket | null = null;
  private media: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private googleAudioContext: AudioContext | null = null;
  private googleMicSource: MediaStreamAudioSourceNode | null = null;
  private googleMicProcessor: ScriptProcessorNode | null = null;
  private googlePlaybackSources = new Set<AudioBufferSourceNode>();
  private googlePlaybackTime = 0;
  private closed = false;
  private toolBuffers = new Map<string, ToolBuffer>();

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks = {},
  ) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Realtime Talk requires microphone access");
    }
    this.closed = false;
    this.callbacks.onStatus?.("connecting");
    const session = await this.client.request<RealtimeTalkSessionResult>("talk.realtime.session", {
      sessionKey: this.sessionKey,
    });
    if (session.transport === "google-live-websocket") {
      await this.startGoogleLive(session);
      return;
    }
    await this.startOpenAIRealtime(session);
  }

  private async startOpenAIRealtime(session: RealtimeTalkSessionResult): Promise<void> {
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("Realtime Talk requires browser WebRTC support");
    }
    this.peer = new RTCPeerConnection();
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.style.display = "none";
    document.body.append(this.audio);
    this.peer.addEventListener("track", (event) => {
      if (this.audio) {
        this.audio.srcObject = event.streams[0];
      }
    });
    this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of this.media.getAudioTracks()) {
      this.peer.addTrack(track, this.media);
    }
    this.channel = this.peer.createDataChannel("oai-events");
    this.channel.addEventListener("open", () => this.callbacks.onStatus?.("listening"));
    this.channel.addEventListener("message", (event) => this.handleOpenAIRealtimeEvent(event.data));
    this.peer.addEventListener("connectionstatechange", () => {
      if (this.closed) {
        return;
      }
      if (this.peer?.connectionState === "failed" || this.peer?.connectionState === "closed") {
        this.callbacks.onStatus?.("error", "Realtime connection closed");
      }
    });

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    const sdp = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${session.clientSecret}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!sdp.ok) {
      throw new Error(`Realtime WebRTC setup failed (${sdp.status})`);
    }
    await this.peer.setRemoteDescription({
      type: "answer",
      sdp: await sdp.text(),
    });
  }

  private async startGoogleLive(session: RealtimeTalkSessionResult): Promise<void> {
    if (typeof WebSocket === "undefined") {
      throw new Error("Google Live Talk requires browser WebSocket support");
    }
    if (!session.websocketUrl || !session.googleLiveSetup) {
      throw new Error("Google Live Talk session is missing setup data");
    }

    this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.googleAudioContext = new AudioContext({ sampleRate: 16_000 });
    this.googleMicSource = this.googleAudioContext.createMediaStreamSource(this.media);
    this.googleMicProcessor = this.googleAudioContext.createScriptProcessor(4096, 1, 1);
    this.googleMicProcessor.onaudioprocess = (event) => {
      if (this.closed || this.googleWs?.readyState !== WebSocket.OPEN) {
        return;
      }
      const sampleRate = Math.round(this.googleAudioContext?.sampleRate ?? 16_000);
      this.sendGoogleLive({
        realtimeInput: {
          audio: {
            data: pcmFloat32ToBase64(event.inputBuffer.getChannelData(0)),
            mimeType: `audio/pcm;rate=${sampleRate}`,
          },
        },
      });
    };
    this.googleMicSource.connect(this.googleMicProcessor);
    this.googleMicProcessor.connect(this.googleAudioContext.destination);

    const url = new URL(session.websocketUrl);
    url.searchParams.set("access_token", session.clientSecret);
    this.googleWs = new WebSocket(url.toString());
    this.googleWs.addEventListener("open", () => {
      this.sendGoogleLive({ setup: session.googleLiveSetup });
    });
    this.googleWs.addEventListener("message", (event) => this.handleGoogleLiveEvent(event.data));
    this.googleWs.addEventListener("close", () => {
      if (!this.closed) {
        this.callbacks.onStatus?.("error", "Realtime connection closed");
      }
    });
    this.googleWs.addEventListener("error", () => {
      if (!this.closed) {
        this.callbacks.onStatus?.("error", "Realtime connection failed");
      }
    });
  }

  stop(): void {
    this.closed = true;
    this.callbacks.onStatus?.("idle");
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.googleWs?.close();
    this.googleWs = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.audio?.remove();
    this.audio = null;
    this.googleMicProcessor?.disconnect();
    this.googleMicProcessor = null;
    this.googleMicSource?.disconnect();
    this.googleMicSource = null;
    this.stopGooglePlayback();
    void this.googleAudioContext?.close();
    this.googleAudioContext = null;
    this.googlePlaybackTime = 0;
    this.toolBuffers.clear();
  }

  private sendOpenAI(event: unknown): void {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(event));
    }
  }

  private sendGoogleLive(event: unknown): void {
    if (this.googleWs?.readyState === WebSocket.OPEN) {
      this.googleWs.send(JSON.stringify(event));
    }
  }

  private handleOpenAIRealtimeEvent(data: unknown): void {
    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(String(data)) as RealtimeServerEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.callbacks.onTranscript?.({ role: "user", text: event.transcript, final: true });
        }
        return;
      case "response.audio_transcript.done":
        if (event.transcript) {
          this.callbacks.onTranscript?.({
            role: "assistant",
            text: event.transcript,
            final: true,
          });
        }
        return;
      case "response.function_call_arguments.delta":
        this.bufferToolDelta(event);
        return;
      case "response.function_call_arguments.done":
        void this.handleOpenAIToolCall(event);
        return;
      default:
        return;
    }
  }

  private bufferToolDelta(event: RealtimeServerEvent): void {
    const key = event.item_id ?? "unknown";
    const existing = this.toolBuffers.get(key);
    if (existing) {
      existing.args += event.delta ?? "";
      return;
    }
    this.toolBuffers.set(key, {
      name: event.name ?? "",
      callId: event.call_id ?? "",
      args: event.delta ?? "",
    });
  }

  private async handleOpenAIToolCall(event: RealtimeServerEvent): Promise<void> {
    const key = event.item_id ?? "unknown";
    const buffered = this.toolBuffers.get(key);
    this.toolBuffers.delete(key);
    const name = buffered?.name || event.name || "";
    const callId = buffered?.callId || event.call_id || "";
    let args: unknown = {};
    try {
      args = JSON.parse(buffered?.args || event.arguments || "{}");
    } catch {}
    await this.handleToolCall(name, callId, args);
  }

  private async handleToolCall(name: string, callId: string, args: unknown): Promise<void> {
    if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME || !callId) {
      return;
    }
    this.callbacks.onStatus?.("thinking");
    let question = "";
    try {
      question = buildRealtimeVoiceAgentConsultChatMessage(args);
    } catch {}
    if (!question) {
      this.submitToolResult(callId, {
        error: `${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} requires a question`,
      });
      this.callbacks.onStatus?.("listening");
      return;
    }
    try {
      const idempotencyKey = generateUUID();
      const response = await this.client.request<{ runId?: string }>("chat.send", {
        sessionKey: this.sessionKey,
        message: question,
        idempotencyKey,
      });
      const result = await waitForChatResult({
        client: this.client,
        runId: response.runId ?? idempotencyKey,
        timeoutMs: 120_000,
      });
      this.submitToolResult(callId, { result });
    } catch (error) {
      this.submitToolResult(callId, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.callbacks.onStatus?.("listening");
    }
  }

  private submitToolResult(callId: string, result: unknown): void {
    if (this.googleWs) {
      this.sendGoogleLive({
        toolResponse: {
          functionResponses: [
            {
              id: callId,
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              response: toFunctionResponseObject(result),
              scheduling: "WHEN_IDLE",
            },
          ],
        },
      });
      return;
    }

    this.sendOpenAI({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.sendOpenAI({ type: "response.create" });
  }

  private handleGoogleLiveEvent(data: unknown): void {
    let event: GoogleLiveServerMessage;
    try {
      event = JSON.parse(String(data)) as GoogleLiveServerMessage;
    } catch {
      return;
    }
    if (event.setupComplete) {
      this.callbacks.onStatus?.("listening");
    }
    if (event.serverContent) {
      this.handleGoogleServerContent(event.serverContent);
    }
    for (const call of event.toolCall?.functionCalls ?? []) {
      const name = call.name?.trim() ?? "";
      const callId = call.id?.trim() ?? "";
      void this.handleToolCall(name, callId, call.args ?? {});
    }
  }

  private handleGoogleServerContent(
    content: NonNullable<GoogleLiveServerMessage["serverContent"]>,
  ): void {
    if (content.interrupted) {
      this.stopGooglePlayback();
    }
    if (content.inputTranscription?.text) {
      this.callbacks.onTranscript?.({
        role: "user",
        text: content.inputTranscription.text,
        final: content.inputTranscription.finished ?? false,
      });
    }
    if (content.outputTranscription?.text) {
      this.callbacks.onTranscript?.({
        role: "assistant",
        text: content.outputTranscription.text,
        final: content.outputTranscription.finished ?? false,
      });
    }
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.playGooglePcmAudio(part.inlineData.data, parsePcmSampleRate(part.inlineData.mimeType));
      } else if (!part.thought && part.text?.trim() && !content.outputTranscription?.text) {
        this.callbacks.onTranscript?.({
          role: "assistant",
          text: part.text,
          final: content.turnComplete ?? false,
        });
      }
    }
  }

  private playGooglePcmAudio(base64: string, sampleRate: number): void {
    const context = this.googleAudioContext;
    if (!context) {
      return;
    }
    const pcm = base64ToInt16Array(base64);
    if (pcm.length === 0) {
      return;
    }
    const buffer = context.createBuffer(1, pcm.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) {
      channel[index] = Math.max(-1, Math.min(1, (pcm[index] ?? 0) / 32768));
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.addEventListener("ended", () => {
      this.googlePlaybackSources.delete(source);
    });
    const startAt = Math.max(context.currentTime, this.googlePlaybackTime);
    this.googlePlaybackTime = startAt + buffer.duration;
    this.googlePlaybackSources.add(source);
    source.start(startAt);
  }

  private stopGooglePlayback(): void {
    for (const source of this.googlePlaybackSources) {
      try {
        source.stop();
      } catch {}
    }
    this.googlePlaybackSources.clear();
    this.googlePlaybackTime = this.googleAudioContext?.currentTime ?? 0;
  }
}

function toFunctionResponseObject(result: unknown): Record<string, unknown> {
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { output: result };
}

function pcmFloat32ToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary);
}

function base64ToInt16Array(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

function parsePcmSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/(?:^|[;,\s])rate=(\d+)/i);
  const parsed = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24_000;
}
