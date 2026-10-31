import type { DesktopObserveResult } from "@openclaw/gateway-protocol";
import { onSettled } from "solid-js";
import { resolveGatewayWebSocketUrl } from "../../lib/gateway-websocket-url.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import type { DesktopAudioState } from "./desktop-audio-view.tsx";

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
      this.sources.delete(source);
      stopEnded();
      source.disconnect();
    };
    const stopEnded = listen(source, "ended", ended);
    this.sources.set(source, stopEnded);
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
    for (const [source, stopEnded] of sources) {
      stopEnded();
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
export function createDesktopAudio(
  host: Pick<HTMLElement, "ownerDocument" | "isConnected"> & {
    embedded: boolean;
    presented: boolean;
  },
  target: () => { connected: boolean; reconnect: () => void },
) {
  // Protocol admission is synchronous; the view reads through its projection.
  let playbackState: DesktopAudioState = "unavailable";
  let changed: (() => void) | undefined;
  const presentation = projectSource(() => playbackState, {
    read: (read) => read(),
    subscribe: (_read, notify) => {
      changed = notify;
      return () => {
        changed = undefined;
      };
    },
    equality: Object.is,
  });
  let activeSocket: WebSocket | null = null;
  let removeSocketListeners: (() => void) | null = null;
  let activeContext: AudioContext | null = null;
  let queue: DesktopPcmQueue | null = null;
  let generation = 0;
  let intent = 0;
  let pendingStops = 0;
  let startReady = false;
  let startRequested = false;
  const visible = () => !host.ownerDocument.hidden && (!host.embedded || host.presented);
  onSettled(() => {
    const stopVisibility = listen(host.ownerDocument, "visibilitychange", () => {
      if (host.ownerDocument.hidden) {
        retire();
      }
    });
    return () => {
      stopVisibility();
      changed = undefined;
      close();
    };
  });

  function toggle(): void {
    if (playbackState === "playing" || playbackState === "starting") {
      stop("muted");
    } else if (playbackState === "retired") {
      target().reconnect();
    } else if (target().connected && visible()) {
      unmute();
    }
  }

  function connect(
    observation: Pick<DesktopObserveResult, "audio" | "audioUnavailableReason">,
    gatewayUrl: string,
  ): void {
    close();
    const stream = observation.audio;
    if (!stream) {
      if (observation.audioUnavailableReason === "setup-unavailable") {
        setState("setup-unavailable");
      }
      return;
    }
    if (!visible()) {
      // An observation may settle after hiding, before audio was advertised.
      // Keep explicit recovery without attaching a hidden socket.
      retire(true);
      return;
    }
    if (typeof AudioContext !== "function") {
      setState("unsupported");
      return;
    }
    const connection = generation;
    pendingStops = 0;
    try {
      const socket = new WebSocket(resolveGatewayWebSocketUrl(stream.wsPath, gatewayUrl));
      activeSocket = socket;
      socket.binaryType = "arraybuffer";
      const current = () => connection === generation && activeSocket === socket;
      const opened = () => {
        if (current()) {
          setState("muted");
        }
      };
      const message = (event: MessageEvent<unknown>) => {
        if (!current()) {
          return;
        }
        if (typeof event.data === "string") {
          handleStatus(event.data);
        } else if (event.data instanceof ArrayBuffer && playbackState === "playing") {
          if (activeContext?.state !== "running") {
            stop("blocked");
            return;
          }
          try {
            queue?.play(new Uint8Array(event.data));
          } catch {
            stop("error");
          }
        }
      };
      const failed = () => {
        if (current()) {
          close();
          setState("error");
        }
      };
      const stops = [
        listen(socket, "open", opened),
        // SAFETY: WebSocket message events are MessageEvent; listen accepts EventListener.
        listen(socket, "message", message as EventListener),
        listen(socket, "error", failed),
        listen(socket, "close", failed),
      ];
      removeSocketListeners = () => stops.forEach((dispose) => dispose());
      setState("connecting");
    } catch {
      close();
      setState("error");
    }
  }

  /** Called directly by the button handler: resume must retain user activation. */
  function unmute(): void {
    const socket = activeSocket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      playbackState === "starting" ||
      playbackState === "playing"
    ) {
      return;
    }
    const connection = generation;
    const playback = ++intent;
    try {
      const context = new AudioContext({ latencyHint: "interactive", sampleRate: SAMPLE_RATE });
      activeContext = context;
      const resumed = context.resume();
      setState("starting");
      void resumed.then(
        () => {
          if (connection !== generation || playback !== intent || activeContext !== context) {
            return;
          }
          if (context.state !== "running") {
            stop("blocked");
            return;
          }
          startReady = true;
          startCapture();
        },
        () => {
          if (connection === generation && playback === intent) {
            stop("blocked");
          }
        },
      );
    } catch {
      stop("blocked");
    }
  }

  function retire(
    advertised = playbackState !== "unavailable" && playbackState !== "setup-unavailable",
  ): void {
    const setupUnavailable = playbackState === "setup-unavailable";
    close();
    if (setupUnavailable && !advertised) {
      setState("setup-unavailable");
    }
    if (advertised) {
      setState("retired");
    }
  }

  function close(): void {
    ++generation;
    stop("unavailable");
    const socket = activeSocket;
    activeSocket = null;
    removeSocketListeners?.();
    removeSocketListeners = null;
    socket?.close();
  }

  function stop(state: DesktopAudioState): void {
    ++intent;
    startReady = false;
    startRequested = false;
    queue?.stop();
    queue = null;
    const context = activeContext;
    activeContext = null;
    if (context) {
      void context.close().catch(() => undefined);
    }
    if (activeSocket?.readyState === WebSocket.OPEN) {
      try {
        pendingStops += 1;
        activeSocket.send(JSON.stringify({ action: "stop" }));
      } catch {
        // Local teardown must still silence playback after a transport failure.
      }
    }
    setState(state);
  }

  function startCapture(): void {
    // A stopped acknowledgment is the ordered barrier for the old capture.
    // Do not send the new start until every prior stop has crossed that barrier:
    // a superseded start may still acknowledge, or be canceled without an ack.
    const socket = activeSocket;
    if (!socket || !startReady || pendingStops > 0) {
      return;
    }
    startReady = false;
    startRequested = true;
    try {
      socket.send(JSON.stringify({ action: "start" }));
    } catch {
      stop("error");
    }
  }

  function handleStatus(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || !("state" in message)) {
      return;
    }
    if (pendingStops > 0) {
      if (message.state === "stopped") {
        pendingStops -= 1;
        startCapture();
      }
      return;
    }
    if (message.state === "started" && playbackState === "starting" && startRequested) {
      startRequested = false;
      if (activeContext?.state !== "running") {
        stop("blocked");
        return;
      }
      // PCM before this acknowledgment belongs to an old capture. Start with a
      // fresh stereo-frame remainder exactly at the accepted capture boundary.
      queue = new DesktopPcmQueue(activeContext);
      setState("playing");
    } else if (
      (playbackState === "starting" || playbackState === "playing") &&
      (message.state === "error" || message.state === "stopped")
    ) {
      stop("error");
    }
  }

  function setState(state: DesktopAudioState): void {
    playbackState = state;
    if (host.isConnected) {
      changed?.();
    }
  }

  return { state: presentation.read, toggle, connect, retire, close };
}

export type DesktopAudio = ReturnType<typeof createDesktopAudio>;
