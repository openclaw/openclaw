import WebSocket, { type RawData } from "ws";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildInstructions } from "./instructions.js";
import type {
  VoiceClawRealtimeAdapter,
  VoiceClawRealtimeAdapterOptions,
  VoiceClawRealtimeToolDeclaration,
  VoiceClawSendToClient,
  VoiceClawSessionConfigEvent,
} from "./types.js";

const log = createSubsystemLogger("gateway").child("voiceclaw-realtime");

const XAI_REALTIME_BASE_URL = "wss://api.x.ai/v1/realtime";
const DEFAULT_MODEL = "grok-voice-think-fast-1.0";
const SETUP_TIMEOUT_MS = 15_000;
const MAX_PENDING_AUDIO = 50;
const MAX_PENDING_CONTROL = 20;
const MAX_PENDING_TOOL = 20;
const RECONNECTABLE_CLOSE_CODES = new Set([1001, 1006, 1007, 1011, 1012, 1013]);
const MAX_RECONNECT_ATTEMPTS = 2;
const RECONNECT_BACKOFF_MS = 500;
const DEFAULT_INPUT_AUDIO_FORMAT = "pcm16";
const DEFAULT_OUTPUT_AUDIO_FORMAT = "pcm16";

// xAI documents these voices for the Voice Agent API.
// https://docs.x.ai/developers/model-capabilities/audio/voice-agent
export const XAI_VOICES = ["eve", "ara", "rex", "sal", "leo"] as const;
export type XaiVoice = (typeof XAI_VOICES)[number];
export const DEFAULT_XAI_VOICE: XaiVoice = "ara";

type XaiMessage = Record<string, unknown>;

/**
 * VoiceClaw realtime brain adapter for xAI's Voice Agent API.
 *
 * xAI's Realtime API is documented as OpenAI-Realtime-protocol-compatible
 * (https://docs.x.ai/developers/model-capabilities/audio/voice-agent), with
 * two known wire deltas:
 *
 *   1. `response.text.delta` (xAI) vs `response.output_text.delta` (OpenAI)
 *   2. User-transcription single `completed` event vs OpenAI's split delta/completed pair
 *
 * The adapter emits OpenClaw-normalized events
 * (`audio.delta`, `transcript.delta`, `transcript.done`, `tool.call`, etc.)
 * defined in `./types.ts`. Tool calls are surfaced via the standard
 * `tool.call` / `tool.result` flow; the gateway tool runtime is responsible
 * for dispatching to OpenClaw tools and returning results.
 *
 * No live xAI calls are issued from CI; tests mock the upstream WebSocket.
 * The xAI API key (`XAI_API_KEY`) is read once at upstream-open and is never
 * logged, returned in errors, or persisted.
 */
export class VoiceClawXaiRealtimeAdapter implements VoiceClawRealtimeAdapter {
  private upstream: WebSocket | null = null;
  private sendToClient: VoiceClawSendToClient | null = null;
  private config: VoiceClawSessionConfigEvent | null = null;
  private tools: VoiceClawRealtimeToolDeclaration[] = [];
  private transcript: { role: "user" | "assistant"; text: string }[] = [];
  private currentAssistantText = "";
  private currentUserText = "";
  private userSpeaking = false;
  private disconnected = false;
  private isReconnecting = false;
  private pendingToolCalls = 0;
  private pendingToolCallIds = new Set<string>();
  private asyncToolCallIds = new Set<string>();
  private pendingAudio: string[] = [];
  private pendingControl: string[] = [];
  private pendingToolResults: string[] = [];
  private model: string = DEFAULT_MODEL;
  private resolvedVoice: XaiVoice = DEFAULT_XAI_VOICE;

  async connect(
    config: VoiceClawSessionConfigEvent,
    sendToClient: VoiceClawSendToClient,
    options?: VoiceClawRealtimeAdapterOptions,
  ): Promise<void> {
    this.config = config;
    this.sendToClient = sendToClient;
    this.tools = options?.tools ?? [];
    this.disconnected = false;
    this.model = config.model || DEFAULT_MODEL;
    this.resolvedVoice = resolveXaiVoice(config.voice);
    await this.openUpstream();
  }

  sendAudio(data: string): void {
    // xAI Realtime accepts PCM16 at the sample rate declared in
    // `session.update`. The OpenClaw client is expected to send PCM16
    // already; we forward base64-encoded audio frames as-is.
    this.sendUpstream(
      {
        type: "input_audio_buffer.append",
        audio: data,
      },
      "audio",
    );
  }

  commitAudio(): void {
    // Used only when server VAD is disabled; with `server_vad` xAI handles
    // turn detection and we don't manually commit. We forward the event
    // anyway so callers that disable server VAD work correctly.
    this.sendUpstream(
      {
        type: "input_audio_buffer.commit",
      },
      "control",
    );
  }

  sendFrame(_data: string, _mimeType?: string): void {
    // xAI Voice Agent is audio-only at GA. Drop frames with a logged
    // warning rather than fail-close so callers can probe capability.
    log.warn("xAI Realtime brain does not accept video/image frames; dropping");
  }

  createResponse(): void {
    this.sendUpstream(
      {
        type: "response.create",
      },
      "control",
    );
  }

  cancelResponse(): void {
    // OpenAI-Realtime semantics include `response.cancel`; xAI does not
    // explicitly document the event but is protocol-compatible. Best-effort
    // forward; if the server ignores it, that's a no-op.
    this.sendUpstream(
      {
        type: "response.cancel",
      },
      "control",
    );
  }

  beginAsyncToolCall(callId: string): void {
    this.asyncToolCallIds.add(callId);
  }

  finishAsyncToolCall(callId: string): void {
    this.asyncToolCallIds.delete(callId);
  }

  sendToolResult(callId: string, output: string): void {
    this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
    this.pendingToolCallIds.delete(callId);
    // xAI / OpenAI-Realtime tool-result protocol:
    //   1. Add a `function_call_output` conversation item with the result.
    //   2. Send `response.create` to resume generation.
    this.sendUpstream(
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output,
        },
      },
      "tool",
    );
    this.sendUpstream(
      {
        type: "response.create",
      },
      "tool",
    );
  }

  injectContext(text: string): void {
    log.info(`injecting async context into xAI Realtime (${text.length} chars)`);
    this.sendUpstream(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text,
            },
          ],
        },
      },
      "control",
    );
  }

  getTranscript(): { role: "user" | "assistant"; text: string }[] {
    return [...this.transcript];
  }

  disconnect(): void {
    this.disconnected = true;
    this.flushPendingTranscripts();
    this.asyncToolCallIds.clear();
    if (this.upstream && this.upstream.readyState !== WebSocket.CLOSED) {
      try {
        this.upstream.close();
      } catch {
        // ignore close errors
      }
    }
    this.upstream = null;
    this.sendToClient = null;
  }

  private openUpstream(): Promise<void> {
    if (!this.config) {
      throw new Error("xAI Realtime adapter opened before session config");
    }

    const apiKey = process.env.XAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("XAI_API_KEY is required for VoiceClaw xAI real-time brain mode");
    }

    const url = `${XAI_REALTIME_BASE_URL}?model=${encodeURIComponent(this.model)}`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    this.upstream = ws;

    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        if (err) {
          ws.off("open", onOpen);
          ws.off("message", onMessage);
          ws.off("error", onError);
          ws.off("close", onClose);
          ws.on("error", () => {});
          ws.on("close", () => {});
          if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
            try {
              ws.close(1011, "setup failed");
            } catch {
              // ignore close errors
            }
          }
          if (this.upstream === ws) {
            this.upstream = null;
          }
          reject(err);
          return;
        }
        resolve();
      };

      const onOpen = () => {
        try {
          this.sendSessionUpdate(this.config!);
          this.replayConversationHistory(this.config!);
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      };

      let setupComplete = false;

      const onMessage = (raw: RawData) => {
        try {
          const msg = JSON.parse(rawDataToString(raw)) as XaiMessage;
          if (
            !setupComplete &&
            (msg.type === "session.created" || msg.type === "session.updated")
          ) {
            setupComplete = true;
            log.info(`xAI Realtime setup complete model=${this.model}`);
            finish();
            this.flushPending();
            return;
          }
          this.handleServerMessage(msg);
        } catch (err) {
          log.warn(`failed to parse xAI Realtime message: ${sanitizeErrorMessage(String(err))}`);
        }
      };

      const onError = (err: Error) => {
        finish(new Error(sanitizeErrorMessage(err.message)));
      };

      const onClose = (code: number, reason: Buffer) => {
        if (!settled) {
          finish(new Error(sanitizeErrorMessage(String(reason) || "xAI Realtime setup failed")));
          return;
        }
        this.handleUpstreamClose(code);
      };

      const timeoutHandle = setTimeout(
        () => finish(new Error("xAI Realtime setup timed out")),
        SETUP_TIMEOUT_MS,
      );

      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("error", onError);
      ws.on("close", onClose);
    });
  }

  private sendSessionUpdate(config: VoiceClawSessionConfigEvent): void {
    const session: Record<string, unknown> = {
      modalities: ["text", "audio"],
      voice: this.resolvedVoice,
      instructions: buildInstructions(config),
      input_audio_format: DEFAULT_INPUT_AUDIO_FORMAT,
      output_audio_format: DEFAULT_OUTPUT_AUDIO_FORMAT,
      input_audio_transcription: {
        // xAI defaults are sufficient; the server emits a single
        // `completed` user-transcription event we synthesize delta+done from.
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    };

    if (this.tools.length > 0) {
      session.tools = this.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      session.tool_choice = "auto";
    }

    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(
        JSON.stringify({
          type: "session.update",
          session,
        }),
      );
    }
  }

  private replayConversationHistory(config: VoiceClawSessionConfigEvent): void {
    const history = config.conversationHistory;
    if (!history || history.length === 0) {
      return;
    }
    for (const entry of history.slice(-12)) {
      this.sendUpstream(
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: entry.role,
            content: [
              {
                type: entry.role === "user" ? "input_text" : "text",
                text: entry.text,
              },
            ],
          },
        },
        "control",
      );
    }
  }

  private handleServerMessage(msg: XaiMessage): void {
    const type = typeof msg.type === "string" ? msg.type : "";

    switch (type) {
      // Audio output — xAI emits `response.output_audio.delta` carrying base64 PCM16.
      // Some OpenAI-Realtime-compatible servers also emit `response.audio.delta`.
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const data = asString(msg.delta);
        if (data) {
          this.sendToClient?.({ type: "audio.delta", data });
        }
        return;
      }

      // Assistant text — xAI rename: `response.text.delta` (OpenAI uses `response.output_text.delta`).
      // Accept both event names so the same adapter can serve OpenAI Realtime later.
      case "response.text.delta":
      case "response.output_text.delta": {
        const text = asString(msg.delta);
        if (text) {
          this.flushUserTranscript();
          this.userSpeaking = false;
          this.currentAssistantText += text;
          this.sendToClient?.({ type: "transcript.delta", text, role: "assistant" });
        }
        return;
      }

      case "response.text.done":
      case "response.output_text.done": {
        // The accumulated assistant text is flushed via response.done below.
        return;
      }

      // User transcription — xAI emits a single `completed` event for both
      // partial and final user-speech transcription. Synthesize OpenClaw's
      // delta + done pair so the gateway-level event taxonomy is preserved.
      case "conversation.item.input_audio_transcription.completed": {
        const text = asString(msg.transcript);
        if (text) {
          if (!this.userSpeaking) {
            this.userSpeaking = true;
            this.sendToClient?.({ type: "turn.started" });
          }
          this.flushAssistantTranscript();
          this.currentUserText += text;
          this.sendToClient?.({ type: "transcript.delta", text, role: "user" });
          // For xAI we also synthesize the done event immediately since
          // there's no separate finalization signal for user transcription.
          this.flushUserTranscript();
        }
        return;
      }

      // OpenAI-Realtime-style split user-transcription events. Accept for
      // forward-compatibility / shared-base reuse.
      case "conversation.item.input_audio_transcription.delta": {
        const text = asString(msg.delta);
        if (text) {
          if (!this.userSpeaking) {
            this.userSpeaking = true;
            this.sendToClient?.({ type: "turn.started" });
          }
          this.flushAssistantTranscript();
          this.currentUserText += text;
          this.sendToClient?.({ type: "transcript.delta", text, role: "user" });
        }
        return;
      }

      // Server VAD: user started speaking → emit OpenClaw turn.started.
      case "input_audio_buffer.speech_started": {
        if (!this.userSpeaking) {
          this.userSpeaking = true;
          this.sendToClient?.({ type: "turn.started" });
        }
        // Barge-in: if we were emitting an assistant response, finalize
        // its transcript with an ellipsis to mark interruption.
        this.flushAssistantTranscript("...");
        return;
      }

      case "input_audio_buffer.speech_stopped": {
        // Server VAD signals end of user audio; final transcription comes
        // via the `completed` event handled above.
        return;
      }

      // Function call — xAI emits `response.function_call_arguments.done`
      // when the model has fully decided arguments. Surface as OpenClaw tool.call.
      case "response.function_call_arguments.done": {
        const callId = asString(msg.call_id);
        const name = asString(msg.name);
        const args = asString(msg.arguments);
        if (callId && name) {
          this.pendingToolCalls += 1;
          this.pendingToolCallIds.add(callId);
          this.sendToClient?.({
            type: "tool.call",
            callId,
            name,
            arguments: args || "{}",
          });
        }
        return;
      }

      case "response.function_call_arguments.delta": {
        // xAI / OpenAI Realtime stream argument deltas; we aggregate via
        // the .done event above. Suppress.
        return;
      }

      // Response complete → finalize transcripts and emit turn.ended.
      case "response.done": {
        this.flushPendingTranscripts();
        this.userSpeaking = false;
        this.sendToClient?.({ type: "turn.ended" });
        return;
      }

      // Usage / rate-limit metrics.
      case "rate_limits.updated":
      case "response.usage": {
        const usage = asRecord(msg.usage);
        if (usage) {
          this.sendToClient?.({
            type: "usage.metrics",
            promptTokens: asNumber(usage.input_tokens),
            completionTokens: asNumber(usage.output_tokens),
            totalTokens: asNumber(usage.total_tokens),
            inputAudioTokens: asNumber(asRecord(usage.input_token_details)?.audio_tokens),
            outputAudioTokens: asNumber(asRecord(usage.output_token_details)?.audio_tokens),
          });
        }
        return;
      }

      // Error reporting from upstream — sanitize before forwarding.
      case "error": {
        const error = asRecord(msg.error) ?? msg;
        const message = asString(error.message) || "xAI Realtime error";
        const code = numericCode(error.code) ?? 502;
        this.sendToClient?.({
          type: "error",
          message: sanitizeErrorMessage(message),
          code,
        });
        return;
      }

      default:
        // Unhandled events are ignored; xAI / OpenAI Realtime define many
        // event types we don't surface (response.created, response.output_item.added, etc).
        return;
    }
  }

  private handleUpstreamClose(code: number): void {
    if (this.disconnected || this.isReconnecting) {
      return;
    }
    if (this.hasActiveToolCalls()) {
      this.cancelActiveToolCalls("xAI Realtime closed while a tool call was in flight");
      return;
    }
    if (code === 1000) {
      return;
    }
    if (!RECONNECTABLE_CLOSE_CODES.has(code)) {
      this.sendToClient?.({ type: "error", message: "xAI Realtime connection closed", code: 502 });
      return;
    }
    void this.reconnect(`close code ${code}`);
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.isReconnecting || this.disconnected) {
      return;
    }
    this.isReconnecting = true;
    this.flushPendingTranscripts();
    this.userSpeaking = false;
    this.sendToClient?.({ type: "session.rotating" });
    if (this.upstream && this.upstream.readyState !== WebSocket.CLOSED) {
      this.upstream.removeAllListeners();
      try {
        this.upstream.close();
      } catch {
        // ignore close errors
      }
    }
    this.upstream = null;

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      try {
        await this.openUpstream();
        this.isReconnecting = false;
        this.sendToClient?.({
          type: "session.rotated",
          sessionId: `xai-resumed-${Date.now()}`,
        });
        return;
      } catch (err) {
        log.warn(
          `xAI Realtime reconnect failed reason=${reason} attempt=${attempt}: ${sanitizeErrorMessage(
            String(err),
          )}`,
        );
        if (attempt < MAX_RECONNECT_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS));
        }
      }
    }
    this.isReconnecting = false;
    if (this.hasActiveToolCalls()) {
      this.cancelActiveToolCalls("xAI Realtime reconnect failed while a tool call was in flight");
      return;
    }
    this.sendToClient?.({
      type: "error",
      message: "xAI Realtime reconnect failed",
      code: 502,
    });
  }

  private hasActiveToolCalls(): boolean {
    return (
      this.pendingToolCalls > 0 ||
      this.pendingToolCallIds.size > 0 ||
      this.asyncToolCallIds.size > 0
    );
  }

  private cancelActiveToolCalls(message: string): void {
    const callIds = Array.from(new Set([...this.pendingToolCallIds, ...this.asyncToolCallIds]));
    this.pendingToolCalls = 0;
    this.pendingToolCallIds.clear();
    this.asyncToolCallIds.clear();
    if (callIds.length > 0) {
      this.sendToClient?.({ type: "tool.cancelled", callIds });
    }
    this.sendToClient?.({ type: "error", message, code: 502 });
  }

  private sendUpstream(msg: Record<string, unknown>, kind: "audio" | "control" | "tool"): void {
    const payload = JSON.stringify(msg);
    if (this.isReconnecting) {
      queueBounded(kind, payload, {
        audio: this.pendingAudio,
        control: this.pendingControl,
        tool: this.pendingToolResults,
      });
      return;
    }
    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(payload);
    } else {
      queueBounded(kind, payload, {
        audio: this.pendingAudio,
        control: this.pendingControl,
        tool: this.pendingToolResults,
      });
    }
  }

  private flushPending(): void {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      return;
    }
    const control = this.pendingControl;
    const audio = this.pendingAudio;
    const tool = this.pendingToolResults;
    this.pendingControl = [];
    this.pendingAudio = [];
    this.pendingToolResults = [];
    for (const payload of tool) {
      this.upstream.send(payload);
    }
    for (const payload of control) {
      this.upstream.send(payload);
    }
    for (const payload of audio) {
      this.upstream.send(payload);
    }
  }

  private flushPendingTranscripts(): void {
    this.flushUserTranscript();
    this.flushAssistantTranscript();
  }

  private flushUserTranscript(): void {
    if (!this.currentUserText) {
      return;
    }
    this.transcript.push({ role: "user", text: this.currentUserText });
    this.sendToClient?.({ type: "transcript.done", text: this.currentUserText, role: "user" });
    this.currentUserText = "";
  }

  private flushAssistantTranscript(suffix = ""): void {
    if (!this.currentAssistantText) {
      return;
    }
    const text = `${this.currentAssistantText}${suffix}`;
    this.transcript.push({ role: "assistant", text });
    this.sendToClient?.({ type: "transcript.done", text, role: "assistant" });
    this.currentAssistantText = "";
  }
}

export function resolveXaiVoice(voice?: string): XaiVoice {
  if (!voice) {
    return DEFAULT_XAI_VOICE;
  }
  const normalized = voice.toLowerCase();
  const match = XAI_VOICES.find((candidate) => candidate === normalized);
  return match ?? DEFAULT_XAI_VOICE;
}

export function isValidXaiVoice(voice: string): boolean {
  return (XAI_VOICES as readonly string[]).includes(voice.toLowerCase());
}

function queueBounded(
  kind: "audio" | "control" | "tool",
  payload: string,
  queues: { audio: string[]; control: string[]; tool: string[] },
): void {
  if (kind === "tool") {
    if (queues.tool.length < MAX_PENDING_TOOL) {
      queues.tool.push(payload);
    }
    return;
  }
  if (kind === "audio") {
    if (queues.audio.length >= MAX_PENDING_AUDIO) {
      queues.audio.shift();
    }
    queues.audio.push(payload);
    return;
  }
  if (queues.control.length < MAX_PENDING_CONTROL) {
    queues.control.push(payload);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

/**
 * Sanitize log/error strings before they leave the adapter.
 *
 * Removes values that look like the xAI API key — defense-in-depth even
 * though the upstream WS URL no longer carries the key in a query string
 * (we pass it in the Authorization header). Also strips any standalone
 * Bearer tokens that may appear in error context from upstream.
 */
function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/g, "Bearer ***")
    .replace(/(xai-[A-Za-z0-9_-]{16,})/g, "***")
    .replace(/([?&]key=)[^&\s]+/g, "$1***");
}
