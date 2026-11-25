import { vi } from "vitest";
import { AudioContextMock, AudioEventTargetMock } from "./desktop-pcm-queue.test-support.ts";

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
