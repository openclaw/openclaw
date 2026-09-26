import { vi } from "vitest";

// A realm-neutral fixture: the node and jsdom suites share these mocks.
export class AudioEventTargetMock {
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
