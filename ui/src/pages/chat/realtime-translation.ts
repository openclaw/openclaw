import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type RealtimeTranslationInputSource = "microphone" | "shared-audio";
export type RealtimeTranslationDirection = "zh-en" | "en-zh";
export type RealtimeTranslationStatus = "idle" | "connecting" | "translating" | "error";

export type RealtimeTranslationTranscript = {
  role: "user" | "assistant";
  text: string;
  final: boolean;
};

type RealtimeTranslationSessionResult = {
  provider: string;
  transport: "webrtc";
  clientSecret: string;
  offerUrl: string;
  offerHeaders?: Record<string, string>;
  model?: string;
  expiresAt?: number;
};

type RealtimeTranslationEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  error?: unknown;
};

const cancelledSetup = Symbol("cancelledSetup");

function languages(direction: RealtimeTranslationDirection) {
  return direction === "zh-en"
    ? { sourceLanguage: "zh", targetLanguage: "en" }
    : { sourceLanguage: "en", targetLanguage: "zh" };
}

function describeProviderError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Live translation provider error";
  }
  const record = error as Record<string, unknown>;
  for (const key of ["message", "code", "type"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "Live translation provider error";
}

async function openInput(source: RealtimeTranslationInputSource): Promise<MediaStream> {
  const devices = navigator.mediaDevices;
  if (!devices) {
    throw new Error("Live translation requires browser media access");
  }
  if (source === "microphone") {
    if (!devices.getUserMedia) {
      throw new Error("Live translation requires microphone access");
    }
    return devices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }
  if (!devices.getDisplayMedia) {
    throw new Error("This browser cannot share tab or meeting audio");
  }
  const stream = await devices.getDisplayMedia({ video: true, audio: true });
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("The selected tab or window did not provide shared audio");
  }
  return stream;
}

export class RealtimeTranslationSession {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private media: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private closed = false;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly direction: RealtimeTranslationDirection,
    private readonly inputSource: RealtimeTranslationInputSource,
    private readonly callbacks: {
      onStatus?: (status: RealtimeTranslationStatus, detail?: string) => void;
      onTranscript?: (entry: RealtimeTranslationTranscript) => void;
    } = {},
  ) {}

  async start(): Promise<void> {
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("Live translation requires browser WebRTC support");
    }
    this.closed = false;
    this.callbacks.onStatus?.("connecting");
    const session = await this.client.request<RealtimeTranslationSessionResult>(
      "talk.translation.create",
      languages(this.direction),
    );
    if (this.closed) {
      return;
    }

    const peer = new RTCPeerConnection();
    this.peer = peer;
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.style.display = "none";
    document.body.append(this.audio);
    peer.addEventListener("track", (event) => {
      if (this.audio) {
        this.audio.srcObject = event.streams[0];
      }
    });

    const media = await this.awaitSetupStep(peer, openInput(this.inputSource));
    if (media === cancelledSetup) {
      return;
    }
    this.media = media;
    const inputTrack = media.getAudioTracks()[0];
    if (!inputTrack) {
      throw new Error("No audio input track is available");
    }
    inputTrack.addEventListener("ended", () => this.stop(), { once: true });
    peer.addTrack(inputTrack, media);

    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.addEventListener("open", () => this.callbacks.onStatus?.("translating"));
    channel.addEventListener("message", (event) => this.handleEvent(event.data));
    peer.addEventListener("connectionstatechange", () => {
      if (!this.closed && ["failed", "closed"].includes(peer.connectionState)) {
        this.callbacks.onStatus?.("error", "Live translation connection closed");
      }
    });

    const offer = await this.awaitSetupStep(peer, peer.createOffer());
    if (offer === cancelledSetup) {
      return;
    }
    const local = await this.awaitSetupStep(peer, peer.setLocalDescription(offer));
    if (local === cancelledSetup) {
      return;
    }
    const answer = await this.awaitSetupStep(
      peer,
      fetch(session.offerUrl, {
        method: "POST",
        body: offer.sdp,
        headers: {
          ...session.offerHeaders,
          Authorization: `Bearer ${session.clientSecret}`,
          "Content-Type": "application/sdp",
        },
      }),
    );
    if (answer === cancelledSetup) {
      return;
    }
    if (!answer.ok) {
      throw new Error(`Live translation WebRTC setup failed (${answer.status})`);
    }
    const answerSdp = await this.awaitSetupStep(peer, answer.text());
    if (answerSdp === cancelledSetup) {
      return;
    }
    await this.awaitSetupStep(peer, peer.setRemoteDescription({ type: "answer", sdp: answerSdp }));
  }

  stop(): void {
    this.closed = true;
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify({ type: "session.close" }));
    }
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.audio?.remove();
    this.audio = null;
    this.callbacks.onStatus?.("idle");
  }

  private async awaitSetupStep<T>(
    peer: RTCPeerConnection,
    promise: Promise<T>,
  ): Promise<T | typeof cancelledSetup> {
    try {
      return await promise;
    } catch (error) {
      if (this.closed || this.peer !== peer) {
        return cancelledSetup;
      }
      throw error;
    }
  }

  private handleEvent(data: unknown): void {
    if (this.closed) {
      return;
    }
    let event: RealtimeTranslationEvent;
    try {
      event = JSON.parse(String(data)) as RealtimeTranslationEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "session.input_transcript.delta":
        if (event.delta) {
          this.callbacks.onTranscript?.({ role: "user", text: event.delta, final: false });
        }
        return;
      case "session.output_transcript.delta":
        if (event.delta) {
          this.callbacks.onTranscript?.({ role: "assistant", text: event.delta, final: false });
        }
        return;
      case "session.input_transcript.done":
        if (event.transcript ?? event.text) {
          this.callbacks.onTranscript?.({
            role: "user",
            text: event.transcript ?? event.text ?? "",
            final: true,
          });
        }
        return;
      case "session.output_transcript.done":
        if (event.transcript ?? event.text) {
          this.callbacks.onTranscript?.({
            role: "assistant",
            text: event.transcript ?? event.text ?? "",
            final: true,
          });
        }
        return;
      case "session.closed":
        this.stop();
        return;
      case "error":
        this.callbacks.onStatus?.("error", describeProviderError(event.error));
        return;
      default:
    }
  }
}
