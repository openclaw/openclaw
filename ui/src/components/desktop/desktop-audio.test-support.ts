import { vi } from "vitest";

// A realm-neutral fixture: the node and jsdom suites share these mocks.
class AudioEventTargetMock {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener);
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
  // Capture callbacks independently of removal to exercise already-queued events.
  captureDispatch(type: string) {
    const listeners = [...(this.listeners.get(type) ?? [])];
    return (event: Event) => {
      for (const listener of listeners) {
        if (typeof listener === "function") {
          listener.call(this, event);
        } else {
          listener.handleEvent(event);
        }
      }
    };
  }
  dispatchEvent(event: Event) {
    this.captureDispatch(event.type)(event);
    return !event.defaultPrevented;
  }
}

class AudioSourceMock extends AudioEventTargetMock {
  buffer: { duration: number; getChannelData(channel: number): Float32Array } | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

export class AudioContextMock {
  static instances: AudioContextMock[] = [];
  state = "running";
  currentTime = 0;
  destination = {};
  sources: AudioSourceMock[] = [];
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(async () => {
    this.state = "closed";
  });
  constructor() {
    AudioContextMock.instances.push(this);
  }
  createBuffer(channels: number, length: number, rate: number) {
    const samples = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / rate, getChannelData: (channel: number) => samples[channel]! };
  }
  createBufferSource() {
    const source = new AudioSourceMock();
    this.sources.push(source);
    return source;
  }
}

export class AudioSocketMock extends AudioEventTargetMock {
  static OPEN = 1;
  static instances: AudioSocketMock[] = [];
  readyState = 0;
  binaryType = "";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });
  constructor(readonly url: string) {
    super();
    AudioSocketMock.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

export function stubDesktopAudio() {
  AudioSocketMock.instances = [];
  AudioContextMock.instances = [];
  vi.stubGlobal("WebSocket", AudioSocketMock);
  vi.stubGlobal("AudioContext", AudioContextMock);
}

export const desktopAudioStream = {
  wsPath: "/desktop/audio",
  encoding: "pcm-s16le",
  sampleRate: 48000,
  channels: 2,
} as const;
