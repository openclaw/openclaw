/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  AudioSocketMock,
  desktopAudioStream,
  stubDesktopAudio,
} from "./desktop-audio.test-support.ts";
import { createDesktopAudio, type DesktopAudio } from "./desktop-audio.ts";
import { AudioContextMock } from "./desktop-pcm-queue.test-support.ts";

let audio: DesktopAudio;
let unmount: () => void;
beforeEach(() => {
  stubDesktopAudio();
  ({ unmount } = mountSolid(() => {
    audio = createDesktopAudio(
      { ownerDocument: document, isConnected: true, embedded: false, presented: false },
      () => ({ connected: true, reconnect: vi.fn() }),
    );
    return null;
  }));
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});
function connect() {
  audio.connect({ audio: desktopAudioStream }, "wss://gateway.test/base/");
  const socket = AudioSocketMock.instances.at(-1)!;
  socket.open();
  return socket;
}
function resumeWith(result: Promise<void>) {
  class ResumingContext extends AudioContextMock {
    override resume = vi.fn(() => result);
  }
  vi.stubGlobal("AudioContext", ResumingContext);
}
function toggle() {
  audio.toggle();
  return Promise.resolve();
}
async function start() {
  const socket = connect();
  await toggle();
  return socket;
}
function feed(socket: AudioSocketMock, ...packets: (string | ArrayBuffer)[]) {
  packets.forEach((packet) =>
    socket.message(typeof packet === "string" ? JSON.stringify({ state: packet }) : packet),
  );
}
function expectPlayback(context: AudioContextMock, state: string, sources: number) {
  expect([audio.state(), context.sources.length]).toEqual([state, sources]);
}

it("drops old PCM sources at 250ms and trims oversized chunks to their freshest frames", async () => {
  const socket = await start();
  feed(socket, "started");
  const context = AudioContextMock.instances.at(-1)!;
  feed(socket, new ArrayBuffer(4800 * 4), new ArrayBuffer(4800 * 4), new ArrayBuffer(4800 * 4));
  expect(context.sources.slice(0, 2).every((s) => s.stop.mock.calls.length === 1)).toBe(true);
  expect(context.sources[2]!.start).toHaveBeenCalledWith(0);
  expect(context.sources[0]!.listenerCount).toBe(0);
  expect(context.sources[0]!.disconnect).toHaveBeenCalledOnce();
  expect(context.sources[2]!.stop).not.toHaveBeenCalled();
  const large = new Uint8Array(24000 * 4 + 1);
  large[12000 * 4 + 1] = 64;
  large[large.length - 1] = 255;
  feed(socket, large.buffer);
  const newest = context.sources.at(-1)!;
  expect(newest.buffer!.duration).toBe(0.25);
  expect(newest.buffer!.getChannelData(0)[0]).toBe(0.5);
  feed(socket, new Uint8Array([127, 0, 128]).buffer);
  expect(context.sources.at(-1)!.buffer!.getChannelData(0)[0]).toBe(32767 / 32768);
  expect(context.sources.at(-1)!.buffer!.getChannelData(1)[0]).toBe(-1);
  audio.toggle();
  expect(context.close).toHaveBeenCalledOnce();
});

it("releases a naturally ended PCM source and its listener without stopping it again", async () => {
  const socket = await start();
  feed(socket, "started", new ArrayBuffer(4));
  const context = AudioContextMock.instances.at(-1)!;
  const source = context.sources[0]!;
  expect(source.listenerCount).toBe(1);
  source.dispatchEvent(new Event("ended"));
  expect(source.listenerCount).toBe(0);
  expect(source.disconnect).toHaveBeenCalledOnce();
  audio.toggle();
  expect(source.stop).not.toHaveBeenCalled();
  expect(source.disconnect).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
});

it("bounds tiny PCM sources and starts a fresh capture after stop", async () => {
  const socket = await start();
  feed(socket, "started");
  const context = AudioContextMock.instances.at(-1)!;
  for (let i = 0; i < 100; i += 1) {
    feed(socket, new ArrayBuffer(4));
    expect(
      context.sources.filter((s) => s.stop.mock.calls.length === 0).length,
    ).toBeLessThanOrEqual(32);
  }
  feed(socket, new Uint8Array([255, 127, 0]).buffer);
  audio.toggle();
  expect(context.sources.every((s) => s.disconnect.mock.calls.length > 0)).toBe(true);
  expect(context.sources.every((s) => s.listenerCount === 0)).toBe(true);
  expect(context.close).toHaveBeenCalledOnce();
  await toggle();
  feed(socket, "stopped", "started", new Uint8Array([0, 128, 0, 64]).buffer);
  const fresh = AudioContextMock.instances.at(-1)!;
  expect(fresh).not.toBe(context);
  expect(fresh.sources.at(-1)!.buffer!.getChannelData(0)[0]).toBe(-1);
  expect(fresh.sources.at(-1)!.buffer!.getChannelData(1)[0]).toBe(0.5);
  expect(context.sources).toHaveLength(100);
  audio.toggle();
});

it.each(["mute", "replace"])("rejects late resume completion after %s", async (action) => {
  const deferred = createDeferred();
  resumeWith(deferred.promise);
  const socket = connect();
  const lateEvents = [
    new MessageEvent("message", { data: new ArrayBuffer(4) }),
    ...["error", "open", "close"].map((type) => new Event(type)),
  ];
  const dispatches = lateEvents.map((event) => socket.captureDispatch(event.type));
  expect(socket.listenerCount).toBe(4);
  audio.toggle();
  if (action === "mute") {
    audio.toggle();
  } else {
    connect();
  }
  deferred.resolve();
  await Promise.resolve();
  expect(socket.send).not.toHaveBeenCalledWith('{"action":"start"}');
  expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
  if (action === "replace") {
    expect(socket.listenerCount).toBe(0);
    lateEvents.forEach((event, index) => dispatches[index]!(event));
    expect(audio.state()).toBe("muted");
    expect(socket.close).toHaveBeenCalledOnce();
    const replacement = AudioSocketMock.instances.at(-1)!;
    expect(replacement.listenerCount).toBe(4);
    await toggle();
    replacement.message('{"state":"started"}');
    expect(audio.state()).toBe("playing");
    audio.close();
    expect(replacement.listenerCount).toBe(0);
  }
});

it("shows blocked playback and allows a new user gesture without autoplay", async () => {
  resumeWith(Promise.reject(new Error("NotAllowedError")));
  const socket = await start();
  expect(audio.state()).toBe("blocked");
  expect(socket.send).not.toHaveBeenCalledWith('{"action":"start"}');
  socket.message('{"state":"stopped"}');
  vi.stubGlobal("AudioContext", AudioContextMock);
  await toggle();
  socket.message('{"state":"started"}');
  expect(audio.state()).toBe("playing");
});

it("ignores a superseded start and old PCM until the fresh start acknowledgment", async () => {
  const socket = await start();
  audio.toggle();
  await toggle();
  const context = AudioContextMock.instances.at(-1)!;
  const actions = () => socket.send.mock.calls.map(([text]) => JSON.parse(text).action);
  expect(actions()).toEqual(["start", "stop"]);
  feed(socket, "started", new Uint8Array([255, 127, 0]).buffer, new ArrayBuffer(4));
  expectPlayback(context, "starting", 0);
  socket.message('{"state":"stopped"}');
  expect(actions()).toEqual(["start", "stop", "start"]);
  // Unacknowledged PCM must not seed the fresh capture's stereo remainder.
  socket.message(new Uint8Array([255, 127, 0]).buffer);
  expectPlayback(context, "starting", 0);
  feed(socket, "started", new Uint8Array([0, 128, 255, 127, 0, 64, 0, 192]).buffer);
  expectPlayback(context, "playing", 1);
  expect(
    [0, 1].map((channel) => Array.from(context.sources[0]!.buffer!.getChannelData(channel))),
  ).toEqual([
    [-1, 0.5],
    [32767 / 32768, -0.5],
  ]);
  expect(AudioContextMock.instances[0]!.sources).toHaveLength(0);
  expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
});

it("waits for every stop barrier after repeated mute/unmute before starting capture", async () => {
  const socket = await start();
  feed(socket, "started", new ArrayBuffer(4));
  const oldContext = AudioContextMock.instances[0]!;
  audio.toggle();
  await toggle();
  audio.toggle();
  await toggle();
  expect(oldContext.sources[0]!.stop).toHaveBeenCalledOnce();
  expect(oldContext.close).toHaveBeenCalledOnce();
  feed(socket, "error", "stopped");
  expect(socket.send).toHaveBeenCalledTimes(3);
  feed(socket, "started", new ArrayBuffer(4));
  expect(AudioContextMock.instances.at(-1)!.sources).toHaveLength(0);
  socket.message('{"state":"stopped"}');
  expect(socket.send).toHaveBeenCalledTimes(4);
  feed(socket, "started", new ArrayBuffer(4));
  expectPlayback(AudioContextMock.instances.at(-1)!, "playing", 1);
  expect(oldContext.sources).toHaveLength(1);
});

it("does not let a stop acknowledgment bypass a pending browser resume", async () => {
  const socket = connect();
  audio.toggle();
  audio.toggle();
  const deferred = createDeferred();
  resumeWith(deferred.promise);
  audio.toggle();
  feed(socket, "stopped", "started", new ArrayBuffer(4));
  expect(socket.send).not.toHaveBeenCalledWith('{"action":"start"}');
  expect(AudioContextMock.instances.at(-1)!.sources).toHaveLength(0);
  deferred.resolve();
  await Promise.resolve();
  expect(socket.send).toHaveBeenLastCalledWith('{"action":"start"}');
  expect(audio.state()).toBe("starting");
  socket.message('{"state":"started"}');
  expect(audio.state()).toBe("playing");
});

it.each([
  [true, "error"],
  [true, "stopped"],
  [false, "error"],
] as const)(
  "silences playing=%s server %s and rejects late acknowledgments",
  async (playing, state) => {
    const socket = await start();
    if (playing) {
      feed(socket, "started", new ArrayBuffer(4));
    }
    socket.message(JSON.stringify({ state, message: "capture failed" }));
    expect(audio.state()).toBe("error");
    feed(socket, "started", new ArrayBuffer(4), "stopped", "started", new ArrayBuffer(4));
    expect(audio.state()).toBe("error");
    expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
    expect(AudioContextMock.instances[0]!.sources).toHaveLength(playing ? 1 : 0);
  },
);

it("reports unsupported and absent audio without opening a socket", () => {
  audio.connect({}, "wss://gateway.test");
  expect(audio.state()).toBe("unavailable");
  vi.stubGlobal("AudioContext", undefined);
  audio.connect({ audio: desktopAudioStream }, "wss://gateway.test");
  expect(audio.state()).toBe("unsupported");
  expect(AudioSocketMock.instances).toHaveLength(0);
});
