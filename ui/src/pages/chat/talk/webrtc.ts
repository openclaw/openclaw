import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import { formatUiError } from "../../../lib/format-error.ts";
import { RealtimeTalkMediaStreamMeter } from "./audio.ts";
import { RealtimeTalkCameraOwner } from "./camera-owner.ts";
import {
  type RealtimeTalkWebRtcSdpSessionResult,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  steerRealtimeTalkActiveConsult,
  shouldAutoControlRealtimeVoiceAgentText,
  shouldInterruptRealtimeTalkControlResponse,
  submitRealtimeTalkAgentControl,
  submitRealtimeTalkConsult,
  type RealtimeTalkTranscript,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
  type RealtimeTalkTransportStartResult,
} from "./shared.ts";
import { captureRealtimeTalkVideoFrame } from "./video.ts";
import {
  RealtimeTalkWebRtcOfferExchange,
  realtimeTalkCompletedToolCalls,
  realtimeTalkTranscriptItem,
  RealtimeTalkResponseOutcomeOwner,
  realtimeTalkDataChannelMaxMessageSize,
  realtimeTalkImageEvent,
  type RealtimeServerEvent,
  type RealtimeTalkCompletedToolCall,
} from "./webrtc-support.ts";

const MAX_REALTIME_TOOL_ARGUMENT_BYTES = 256_000;
// Realtime defines no replay window, so evicting terminal IDs could execute a
// very late duplicate. End an extreme session instead of weakening dedupe.
const MAX_COMPLETED_TOOL_CALL_IDS = 1_024;
const utf8Encoder = new TextEncoder();

export class WebRtcSdpRealtimeTalkTransport implements RealtimeTalkTransport {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private readonly input = this.ctx.input;
  private audio: HTMLAudioElement | null = null;
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  private closed = false;
  private responseState: "idle" | "requested" | "active" = "idle";
  private responseCreatePending = false;
  private readonly responseOutcomes = new RealtimeTalkResponseOutcomeOwner(
    MAX_COMPLETED_TOOL_CALL_IDS,
  );
  private readonly completedToolCallIds = new Set<string>();
  private readonly offerExchange = new RealtimeTalkWebRtcOfferExchange();
  private readonly camera: RealtimeTalkCameraOwner;
  private readonly consultAbortControllers = new Set<AbortController>();
  private readonly controlAbortController = new AbortController();
  private starting = false;
  private startupError: Error | null = null;

  constructor(
    private readonly session: RealtimeTalkWebRtcSdpSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {
    this.camera = new RealtimeTalkCameraOwner({
      getDeviceId: () => this.ctx.videoDeviceId,
      setDeviceId: (deviceId) => (this.ctx.videoDeviceId = deviceId),
      isClosed: () => this.closed,
      onStream: (stream) => this.ctx.callbacks.onVideoStream?.(stream),
    });
  }

  async start(): Promise<RealtimeTalkTransportStartResult> {
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("Realtime Talk requires browser WebRTC and microphone access");
    }
    this.closed = false;
    this.starting = true;
    this.startupError = null;
    const peer = new RTCPeerConnection();
    this.peer = peer;
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.muted = false;
    this.audio.setAttribute("playsinline", "");
    this.audio.style.display = "none";
    document.body.append(this.audio);
    // Native WebRTC listeners share the transport lifetime, including late media events.
    const listenerOptions = { signal: this.controlAbortController.signal };
    const onTrack = (event: RTCTrackEvent) => {
      const stream = event.streams[0];
      if (this.audio && stream) {
        this.audio.srcObject = stream;
        const audio = this.audio;
        const play = (reportError: boolean) => {
          if (this.audio !== audio || this.closed) {
            return;
          }
          void audio.play().catch((error: unknown) => {
            if (reportError && this.audio === audio && !this.closed) {
              this.ctx.callbacks.onStatus?.(
                "error",
                `Realtime audio playback failed: ${formatUiError(error)}`,
              );
            }
          });
        };
        play(!event.track.muted);
        // iOS can deliver the remote track muted until media starts flowing.
        // Retrying on unmute gives Safari a second chance to attach the live stream.
        event.track.addEventListener("unmute", () => play(true), {
          once: true,
          ...listenerOptions,
        });
      }
    };
    peer.addEventListener("track", onTrack, listenerOptions);
    const media = this.input.adopt((detail) => this.failConnection(detail));
    if (this.ctx.callbacks.onInputLevel) {
      this.inputMeter = new RealtimeTalkMediaStreamMeter(this.ctx.callbacks.onInputLevel);
      this.inputMeter.start(media);
    }
    if (!this.isCurrentPeer(peer)) {
      return this.cancelledStart();
    }
    // Camera frames travel only as explicit describe_view data-channel events.
    // Keeping video off the peer prevents unintended continuous camera upload.
    for (const track of media.getAudioTracks()) {
      peer.addTrack(track, media);
    }
    const channel = peer.createDataChannel("oai-events");
    if (!this.isCurrentPeer(peer)) {
      channel.close();
      return this.cancelledStart();
    }
    this.channel = channel;
    channel.addEventListener(
      "open",
      () => {
        this.ctx.callbacks.onStatus?.("listening");
        if (!this.closed) {
          this.ctx.callbacks.onTalkEvent?.({ type: "session.ready" });
        }
      },
      listenerOptions,
    );
    channel.addEventListener(
      "message",
      (event) => this.handleRealtimeEvent(event.data),
      listenerOptions,
    );
    const onConnectionStateChange = () => {
      if (this.closed) {
        return;
      }
      if (this.peer?.connectionState === "failed" || this.peer?.connectionState === "closed") {
        this.failConnection("Realtime connection closed");
      }
    };
    peer.addEventListener("connectionstatechange", onConnectionStateChange, listenerOptions);

    try {
      const offer = await peer.createOffer();
      if (!this.isCurrentPeer(peer)) {
        return this.cancelledStart();
      }
      await peer.setLocalDescription(offer);
      if (!this.isCurrentPeer(peer)) {
        return this.cancelledStart();
      }
      const answerSdp = await this.offerExchange.readAnswer({
        session: this.session,
        offer,
        gatewayUrl: this.ctx.client.gatewayUrl,
        isCurrent: () => this.isCurrentPeer(peer),
      });
      if (answerSdp === undefined || !this.isCurrentPeer(peer)) {
        return this.cancelledStart();
      }
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      if (!this.isCurrentPeer(peer)) {
        return this.cancelledStart();
      }
    } catch (error) {
      if (!this.isCurrentPeer(peer)) {
        return this.cancelledStart();
      }
      throw error;
    }
    this.starting = false;
    return "ready";
  }

  setVideoEnabled(enabled: boolean): Promise<void> {
    return this.camera.setEnabled(enabled);
  }

  switchCamera(videoDeviceId: string | undefined): Promise<void> {
    return this.camera.switchDevice(videoDeviceId);
  }

  private isCurrentPeer(peer: RTCPeerConnection): boolean {
    return !this.closed && this.peer === peer;
  }

  private cancelledStart(): RealtimeTalkTransportStartResult {
    if (this.startupError) {
      throw this.startupError;
    }
    return "cancelled";
  }

  stop(options?: { emitClosed?: boolean }): void {
    const emitClosed = !this.closed && options?.emitClosed !== false;
    this.closed = true;
    try {
      if (emitClosed) {
        this.ctx.callbacks.onTalkEvent?.({ type: "session.closed" });
      }
    } finally {
      this.releaseResources();
    }
  }

  private releaseResources(): void {
    this.starting = false;
    this.controlAbortController.abort();
    this.input.stop();
    this.offerExchange.abort();
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.camera.release();
    this.inputMeter?.stop();
    this.inputMeter = null;
    this.audio?.remove();
    this.audio = null;
    for (const controller of this.consultAbortControllers) {
      controller.abort();
    }
    this.consultAbortControllers.clear();
    this.completedToolCallIds.clear();
    this.responseOutcomes.reset();
    this.responseState = "idle";
    this.responseCreatePending = false;
  }

  private failConnection(detail: string): void {
    if (this.closed) {
      return;
    }
    const wasStarting = this.starting;
    try {
      if (!wasStarting) {
        this.ctx.callbacks.onStatus?.("error", detail);
      } else {
        this.startupError = new Error(detail);
      }
    } finally {
      // A terminal peer failure still owns browser media if status delivery fails.
      this.stop({ emitClosed: !wasStarting });
    }
  }

  private send(event: unknown): void {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(event));
    }
  }

  private handleRealtimeEvent(data: unknown): void {
    if (this.closed) {
      return;
    }
    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(String(data)) as RealtimeServerEvent;
    } catch {
      return;
    }
    const transcriptItem = realtimeTalkTranscriptItem(event);
    if (transcriptItem) {
      this.ctx.callbacks.onTranscriptItem?.(transcriptItem);
      if (this.closed) {
        return;
      }
    }
    switch (event.type) {
      case "session.input_transcript.delta":
        this.emitTranscript("user", event.delta, false, undefined, "verbatim");
        return;
      case "session.output_transcript.delta":
        this.emitTranscript("assistant", event.delta, false, undefined, "verbatim");
        return;
      case "session.closed":
        if (event.reason === "content" || event.reason === "connection_lost") {
          this.failConnection("Realtime connection closed");
          return;
        }
        try {
          this.ctx.callbacks.onStatus?.("idle");
        } finally {
          this.stop();
        }
        return;
      case "input_transcript.added":
      case "output_transcript.added":
        this.emitTranscript(
          event.type === "input_transcript.added" ? "user" : "assistant",
          event.item?.text,
          false,
          event.item?.id,
          "verbatim",
        );
        return;
      case "turn.done": {
        const role = event.turn?.role;
        if (role === "user" || role === "assistant") {
          this.emitTranscript(role, event.turn?.transcript, true, event.turn?.id, "snapshot");
          if (this.closed) {
            return;
          }
          if (role === "assistant") {
            this.ctx.callbacks.onStatus?.("listening");
          }
        }
        return;
      }
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string") {
          if (!this.emitTranscript("user", event.transcript, true, event.item_id)) {
            return;
          }
          if (
            this.consultAbortControllers.size > 0 &&
            shouldAutoControlRealtimeVoiceAgentText(event.transcript)
          ) {
            void steerRealtimeTalkActiveConsult({
              ctx: this.ctx,
              text: event.transcript,
              onControlResult: (result) => this.interruptSuppressedControlResponse(result),
              speakControlResult: (message) => this.sendControlSpeechMessage(message),
            });
          }
        }
        return;
      case "conversation.output_transcript.delta":
      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        this.emitTranscript("assistant", event.delta, false, event.item_id);
        return;
      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        this.emitTranscript("assistant", event.transcript ?? event.text, true, event.item_id);
        break;
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
        // Tool argument events are provisional and can also arrive for interrupted
        // responses. Only the completed response owns executable calls.
        break;
      case "input_audio_buffer.speech_started":
        this.ctx.callbacks.onStatus?.("listening", "Speech detected");
        return;
      case "input_audio_buffer.speech_stopped":
        this.ctx.callbacks.onStatus?.("thinking", "Processing speech");
        return;
      case "response.created":
        this.responseState = "active";
        this.responseOutcomes.start(event.response?.id);
        this.ctx.callbacks.onStatus?.("thinking", "Generating response");
        return;
      case "response.cancelled":
      case "response.done": {
        const terminal = this.responseOutcomes.finish(event);
        if (!terminal) {
          return;
        }
        const { outcome } = terminal;
        try {
          if (outcome.status === "completed") {
            this.handleCompletedResponse(event);
            if (this.closed) {
              return;
            }
          }
          if (outcome.status === "failed" || outcome.status === "incomplete") {
            this.ctx.callbacks.onStatus?.("error", outcome.message);
          } else {
            this.ctx.callbacks.onStatus?.(
              "listening",
              outcome.status === "cancelled" ? "Response cancelled" : undefined,
            );
          }
        } finally {
          if (terminal.overflow) {
            this.failConnection("Realtime response session limit exceeded");
          }
          this.responseState = "idle";
          if (this.responseCreatePending) {
            this.responseCreatePending = false;
            this.requestResponseCreate();
          }
        }
        return;
      }
      case "error":
      case "conversation.item.input_audio_transcription.failed":
        // ASR runs independently; its failure cannot settle a pending response request.
        if (event.type === "error" && this.responseState === "requested") {
          this.responseState = "idle";
        }
        this.ctx.callbacks.onStatus?.("error", this.extractErrorDetail(event.error));

      default:
    }
  }

  private emitTranscript(
    role: "user" | "assistant",
    text: string | undefined,
    final: boolean,
    itemId?: string,
    textMode?: RealtimeTalkTranscript["textMode"],
  ): boolean {
    let entry: RealtimeTalkTranscript;
    if (textMode) {
      if (!text) {
        return false;
      }
      entry = { role, text, final, textMode };
    } else {
      if (typeof text !== "string") {
        return false;
      }
      entry = { role, text, final, itemId };
    }
    this.ctx.callbacks.onTranscript?.(entry);
    return !this.closed;
  }

  private extractErrorDetail(error: unknown): string {
    const record = isRecord(error) ? error : {};
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const code = typeof record.code === "string" ? record.code.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "";
    return message || code || type || "Realtime provider error";
  }

  private handleCompletedResponse(event: RealtimeServerEvent): void {
    for (const call of realtimeTalkCompletedToolCalls(event)) {
      const { callId, name, args } = call;
      if (
        name !== REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME &&
        name !== REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME &&
        name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME
      ) {
        continue;
      }
      if (this.completedToolCallIds.has(callId)) {
        continue;
      }
      if (this.completedToolCallIds.size >= MAX_COMPLETED_TOOL_CALL_IDS) {
        this.failConnection("Realtime tool-call session limit exceeded");
        return;
      }
      this.completedToolCallIds.add(callId);
      if (utf8Encoder.encode(args).byteLength > MAX_REALTIME_TOOL_ARGUMENT_BYTES) {
        const message = "Realtime tool arguments exceed the 256000-byte UTF-8 limit";
        this.submitToolResult(callId, { error: message });
        continue;
      }
      void this.handleToolCall(call).catch((error: unknown) => {
        if (!this.closed) {
          const message = formatUiError(error);
          this.ctx.callbacks.onStatus?.("error", message);
        }
      });
    }
  }

  private async handleToolCall(call: RealtimeTalkCompletedToolCall): Promise<void> {
    const { callId, name, args } = call;
    if (name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      await submitRealtimeTalkAgentControl({
        ctx: this.ctx,
        callId,
        args,
        signal: this.controlAbortController.signal,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
      return;
    }
    if (name === REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME) {
      await this.handleDescribeViewToolCall(callId);
      return;
    }
    if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      return;
    }
    const abortController = new AbortController();
    this.consultAbortControllers.add(abortController);
    try {
      await submitRealtimeTalkConsult({
        ctx: this.ctx,
        callId,
        args,
        signal: abortController.signal,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
    } finally {
      this.consultAbortControllers.delete(abortController);
    }
  }

  private async handleDescribeViewToolCall(callId: string): Promise<void> {
    const failCapture = (message: string) => {
      this.submitToolResult(callId, { ok: false, error: message });
    };
    if (!this.camera.hasLiveTrack()) {
      failCapture("camera is off");
      return;
    }
    const video = this.camera.video;
    try {
      const frame = await captureRealtimeTalkVideoFrame(
        video,
        realtimeTalkDataChannelMaxMessageSize(this.peer),
        realtimeTalkImageEvent,
      );
      if (this.closed) {
        return;
      }
      // Camera consent and identity can change while the preview becomes ready.
      if (this.camera.video !== video || !this.camera.hasUsableTrack()) {
        failCapture("camera is off");
        return;
      }
      this.send(realtimeTalkImageEvent(frame));
      this.submitToolResult(callId, { ok: true, frameAttached: true });
    } catch (error) {
      if (!this.closed) {
        failCapture(formatUiError(error));
      }
    }
  }

  private submitToolResult(callId: string, result: unknown): void {
    if (this.closed) {
      return;
    }
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.requestResponseCreate();
  }

  private sendControlSpeechMessage(message: string): void {
    if (this.responseState === "active") {
      this.send({ type: "response.cancel" });
    }
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    });
    this.requestResponseCreate();
  }

  private interruptSuppressedControlResponse(result: unknown): void {
    if (this.responseState === "active" && shouldInterruptRealtimeTalkControlResponse(result)) {
      this.send({ type: "response.cancel" });
    }
  }

  private requestResponseCreate(): void {
    if (this.responseState !== "idle") {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseState = "requested";
    this.send({ type: "response.create" });
  }
}
