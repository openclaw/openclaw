import type { DesktopObserveResult } from "@openclaw/gateway-protocol";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { resolveGatewayWebSocketUrl } from "../../lib/gateway-websocket-url.ts";
import {
  renderDesktopAudioControl,
  renderDesktopAudioNotice,
  type DesktopAudioState,
} from "./desktop-audio-view.ts";

type DesktopAudioHost = ReactiveControllerHost & {
  ownerDocument: Document;
  embedded: boolean;
  presented: boolean;
  documentMode: boolean;
};

const SAMPLE_RATE = 48_000;
const FRAME_BYTES = 4;
const MAX_FRAMES = SAMPLE_RATE / 4;
const MAX_SOURCES = 32;

/** A live monitor, not a recording: prefer fresh samples over accumulated latency. */
class DesktopPcmQueue {
  private remainder = new Uint8Array(0);
  private playhead = 0;
  private readonly sources = new Map<AudioBufferSourceNode, () => void>();

  constructor(private readonly context: AudioContext) {}

  play(bytes: Uint8Array): void {
    const totalBytes = this.remainder.length + bytes.length;
    const completeBytes = totalBytes - (totalBytes % FRAME_BYTES);
    // Preserve at most three bytes, including half of a stereo frame. Trimming
    // happens at a frame boundary so left and right never swap after a split.
    const byteAt = (index: number) =>
      index < this.remainder.length
        ? this.remainder[index]!
        : bytes[index - this.remainder.length]!;
    const tail = new Uint8Array(totalBytes - completeBytes);
    for (let i = 0; i < tail.length; i += 1) {
      tail[i] = byteAt(completeBytes + i);
    }
    const frameCount = Math.min(completeBytes / FRAME_BYTES, MAX_FRAMES);
    if (frameCount === 0) {
      this.remainder = tail;
      return;
    }
    const data = new Uint8Array(frameCount * FRAME_BYTES);
    const offset = completeBytes - data.length;
    for (let i = 0; i < data.length; i += 1) {
      data[i] = byteAt(offset + i);
    }
    this.remainder = tail;
    const now = this.context.currentTime;
    const duration = frameCount / SAMPLE_RATE;
    if (Math.max(now, this.playhead) + duration - now > 0.25 || this.sources.size >= MAX_SOURCES) {
      this.clearSources();
    }
    const buffer = this.context.createBuffer(2, frameCount, SAMPLE_RATE);
    const view = new DataView(data.buffer);
    for (let channel = 0; channel < 2; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < frameCount; frame += 1) {
        output[frame] = view.getInt16(frame * FRAME_BYTES + channel * 2, true) / 0x8000;
      }
    }
    const source = this.context.createBufferSource();
    const ended = () => {
      if (!this.sources.delete(source)) {
        return;
      }
      source.removeEventListener("ended", ended);
      source.disconnect();
    };
    this.sources.set(source, ended);
    source.addEventListener("ended", ended);
    source.buffer = buffer;
    source.connect(this.context.destination);
    const start = Math.max(now, this.playhead);
    source.start(start);
    this.playhead = start + duration;
  }

  stop(): void {
    this.remainder = new Uint8Array(0);
    this.clearSources();
  }

  private clearSources(): void {
    const sources = [...this.sources];
    this.sources.clear();
    this.playhead = this.context.currentTime;
    for (const [source, ended] of sources) {
      source.removeEventListener("ended", ended);
      try {
        source.stop();
      } catch {
        // A source may have finished before its ended callback was delivered.
      }
      source.disconnect();
    }
  }
}

/** One desktop observation's receive-only audio socket and playback intent. */
export class DesktopAudio implements ReactiveController {
  state: DesktopAudioState = "unavailable";
  private socket: WebSocket | null = null;
  private removeSocketListeners: (() => void) | null = null;
  private visibilityDocument: Document | null = null;
  private context: AudioContext | null = null;
  private queue: DesktopPcmQueue | null = null;
  private generation = 0;
  private intent = 0;
  private pendingStops = 0;
  private startReady = false;
  private startRequested = false;

  private readonly onVisibilityChange = () => {
    if (this.host.ownerDocument.hidden) {
      this.retire();
    }
  };

  constructor(
    private readonly host: DesktopAudioHost,
    private readonly connected: () => boolean,
    private readonly reconnect: () => void,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.visibilityDocument = this.host.ownerDocument;
    this.visibilityDocument.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  hostDisconnected(): void {
    this.visibilityDocument?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityDocument = null;
    this.close();
  }

  private get visible(): boolean {
    return !this.host.ownerDocument.hidden && (!this.host.embedded || this.host.presented);
  }

  renderButton() {
    return renderDesktopAudioControl({
      state: this.state,
      connected: this.connected(),
      documentMode: this.host.documentMode,
      onToggle: () => {
        if (this.state === "playing" || this.state === "starting") {
          this.mute();
        } else if (this.state === "retired") {
          this.reconnect();
        } else if (this.connected() && this.visible) {
          this.unmute();
        }
      },
    });
  }

  renderNotice() {
    return renderDesktopAudioNotice(this.state);
  }

  connect(
    observation: Pick<DesktopObserveResult, "audio" | "audioUnavailableReason">,
    gatewayUrl: string,
  ): void {
    this.close();
    const stream = observation.audio;
    if (!stream) {
      if (observation.audioUnavailableReason === "setup-unavailable") {
        this.setState("setup-unavailable");
      }
      return;
    }
    if (!this.visible) {
      // An observation may settle after hiding, before audio was advertised.
      // Keep explicit recovery without attaching a hidden socket.
      this.retire(true);
      return;
    }
    if (typeof AudioContext !== "function") {
      this.setState("unsupported");
      return;
    }
    const generation = this.generation;
    this.pendingStops = 0;
    try {
      const socket = new WebSocket(resolveGatewayWebSocketUrl(stream.wsPath, gatewayUrl));
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      const current = () => generation === this.generation && this.socket === socket;
      const opened = () => {
        if (current()) {
          this.setState("muted");
        }
      };
      const message = (event: MessageEvent<unknown>) => {
        if (!current()) {
          return;
        }
        if (typeof event.data === "string") {
          this.handleStatus(event.data);
        } else if (event.data instanceof ArrayBuffer && this.state === "playing") {
          if (this.context?.state !== "running") {
            this.stop("blocked");
            return;
          }
          try {
            this.queue?.play(new Uint8Array(event.data));
          } catch {
            this.stop("error");
          }
        }
      };
      const failed = () => {
        if (current()) {
          this.close();
          this.setState("error");
        }
      };
      this.removeSocketListeners = () => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("message", message);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      socket.addEventListener("open", opened);
      socket.addEventListener("message", message);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
      this.setState("connecting");
    } catch {
      this.close();
      this.setState("error");
    }
  }

  /** Called directly by the button handler: resume must retain user activation. */
  unmute(): void {
    const socket = this.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.state === "starting" ||
      this.state === "playing"
    ) {
      return;
    }
    const generation = this.generation;
    const intent = ++this.intent;
    try {
      const context = new AudioContext({ latencyHint: "interactive", sampleRate: SAMPLE_RATE });
      this.context = context;
      const resumed = context.resume();
      this.setState("starting");
      void resumed.then(
        () => {
          if (
            generation !== this.generation ||
            intent !== this.intent ||
            this.context !== context
          ) {
            return;
          }
          if (context.state !== "running") {
            this.stop("blocked");
            return;
          }
          this.startReady = true;
          this.startCapture();
        },
        () => {
          if (generation === this.generation && intent === this.intent) {
            this.stop("blocked");
          }
        },
      );
    } catch {
      this.stop("blocked");
    }
  }

  mute(): void {
    this.stop("muted");
  }

  retire(advertised = this.state !== "unavailable" && this.state !== "setup-unavailable"): void {
    const setupUnavailable = this.state === "setup-unavailable";
    this.close();
    if (setupUnavailable && !advertised) {
      this.setState("setup-unavailable");
    }
    if (advertised) {
      this.setState("retired");
    }
  }

  close(): void {
    ++this.generation;
    this.stop("unavailable");
    const socket = this.socket;
    this.socket = null;
    this.removeSocketListeners?.();
    this.removeSocketListeners = null;
    socket?.close();
  }

  private stop(state: DesktopAudioState): void {
    ++this.intent;
    this.startReady = false;
    this.startRequested = false;
    this.queue?.stop();
    this.queue = null;
    const context = this.context;
    this.context = null;
    if (context) {
      void context.close().catch(() => undefined);
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.pendingStops += 1;
        this.socket.send(JSON.stringify({ action: "stop" }));
      } catch {
        // Local teardown must still silence playback after a transport failure.
      }
    }
    this.setState(state);
  }

  private startCapture(): void {
    // A stopped acknowledgment is the ordered barrier for the old capture.
    // Do not send the new start until every prior stop has crossed that barrier:
    // a superseded start may still acknowledge, or be canceled without an ack.
    const socket = this.socket;
    if (!socket || !this.startReady || this.pendingStops > 0) {
      return;
    }
    this.startReady = false;
    this.startRequested = true;
    try {
      socket.send(JSON.stringify({ action: "start" }));
    } catch {
      this.stop("error");
    }
  }

  private handleStatus(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || !("state" in message)) {
      return;
    }
    if (this.pendingStops > 0) {
      if (message.state === "stopped") {
        this.pendingStops -= 1;
        this.startCapture();
      }
      return;
    }
    if (message.state === "started" && this.state === "starting" && this.startRequested) {
      this.startRequested = false;
      if (this.context?.state !== "running") {
        this.stop("blocked");
        return;
      }
      // PCM before this acknowledgment belongs to an old capture. Start with a
      // fresh stereo-frame remainder exactly at the accepted capture boundary.
      this.queue = new DesktopPcmQueue(this.context);
      this.setState("playing");
    } else if (
      (this.state === "starting" || this.state === "playing") &&
      (message.state === "error" || message.state === "stopped")
    ) {
      this.stop("error");
    }
  }

  private setState(state: DesktopAudioState): void {
    this.state = state;
    this.host.requestUpdate();
  }
}
