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
function feed(socket: AudioSocketMock, ...packets: (string | ArrayBuffer | number[])[]) {
  packets.forEach((packet) =>
    socket.message(
      typeof packet === "string"
        ? JSON.stringify({ state: packet })
        : Array.isArray(packet)
          ? new Uint8Array(packet).buffer
          : packet,
    ),
  );
}
const context = () => AudioContextMock.instances.at(-1)!;
function expectSamples(expected: number[][]) {
  const buffer = context().sources.at(-1)!.buffer!;
  expect([0, 1].map((channel) => Array.from(buffer.getChannelData(channel)))).toEqual(expected);
}
function expectPlayback(ctx: AudioContextMock, state: string, sources: number) {
  expect([audio.state(), ctx.sources.length]).toEqual([state, sources]);
}

it("drops old PCM sources at 250ms and trims oversized chunks to their freshest frames", async () => {
  const socket = await start();
  feed(socket, "started");
  const ctx = context();
  feed(socket, new ArrayBuffer(4800 * 4), new ArrayBuffer(4800 * 4), new ArrayBuffer(4800 * 4));
  expect(ctx.sources.slice(0, 2).every((s) => s.stop.mock.calls.length === 1)).toBe(true);
  expect(ctx.sources[2]!.start).toHaveBeenCalledWith(0);
  expect(ctx.sources[0]!.listenerCount).toBe(0);
  expect(ctx.sources[0]!.disconnect).toHaveBeenCalledOnce();
  expect(ctx.sources[2]!.stop).not.toHaveBeenCalled();
  const large = new Uint8Array(24000 * 4 + 1);
  large[12000 * 4 + 1] = 64;
  large[large.length - 1] = 255;
  feed(socket, large.buffer);
  const newest = ctx.sources.at(-1)!;
  expect(newest.buffer!.duration).toBe(0.25);
  expect(newest.buffer!.getChannelData(0)[0]).toBe(0.5);
  feed(socket, [127, 0, 128]);
  expectSamples([[32767 / 32768], [-1]]);
});

it("releases a naturally ended PCM source and its listener without stopping it again", async () => {
  const socket = await start();
  feed(socket, "started", new ArrayBuffer(4));
  const source = context().sources[0]!;
  source.dispatchEvent(new Event("ended"));
  expect(source.listenerCount).toBe(0);
  audio.toggle();
  expect(source.stop).not.toHaveBeenCalled();
  expect(source.disconnect).toHaveBeenCalledOnce();
});

it("bounds tiny PCM sources and starts a fresh capture after stop", async () => {
  const socket = await start();
  feed(socket, "started");
  const ctx = context();
  for (let i = 0; i < 100; i += 1) {
    feed(socket, new ArrayBuffer(4));
    expect(ctx.sources.filter((s) => s.stop.mock.calls.length === 0).length).toBeLessThanOrEqual(
      32,
    );
  }
  feed(socket, [255, 127, 0]);
  audio.toggle();
  expect(
    ctx.sources.every((s) => s.disconnect.mock.calls.length > 0 && s.listenerCount === 0),
  ).toBe(true);
  expect(ctx.close).toHaveBeenCalledOnce();
  await toggle();
  feed(socket, "stopped", "started", [0, 128, 0, 64]);
  expect(context()).not.toBe(ctx);
  expectSamples([[-1], [0.5]]);
  expect(ctx.sources).toHaveLength(100);
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
    const replacement = AudioSocketMock.instances.at(-1)!;
    await toggle();
    feed(replacement, "started");
    expect(audio.state()).toBe("playing");
  }
});

it("shows blocked playback and allows a new user gesture without autoplay", async () => {
  resumeWith(Promise.reject(new Error("NotAllowedError")));
  const socket = await start();
  expect(audio.state()).toBe("blocked");
  expect(socket.send).not.toHaveBeenCalledWith('{"action":"start"}');
  feed(socket, "stopped");
  vi.stubGlobal("AudioContext", AudioContextMock);
  await toggle();
  feed(socket, "started");
  expect(audio.state()).toBe("playing");
});

it.each([
  [false, 1, true],
  [true, 2, true],
  [false, 1, false],
] as const)(
  "waits for all barriers (playing=%s, stops=%s, resumed=%s)",
  async (playing, stops, resumed) => {
    const socket = await start();
    const previous = context();
    if (playing) {
      feed(socket, "started", new ArrayBuffer(4));
    }
    const deferred = createDeferred();
    for (let i = 0; i < stops; i++) {
      audio.toggle();
      if (i === stops - 1) {
        resumeWith(deferred.promise);
      }
      await toggle();
    }
    const ctx = context();
    const actions = () => socket.send.mock.calls.map(([text]) => JSON.parse(text).action);
    const pending = ["start", ...Array<string>(stops).fill("stop")];
    if (resumed) {
      deferred.resolve();
      await Promise.resolve();
    }
    for (let i = 0; i < stops; i++) {
      feed(socket, "error", "started", [255, 127, 0], new ArrayBuffer(4));
      expectPlayback(ctx, "starting", 0);
      expect(actions()).toEqual(pending);
      feed(socket, "stopped");
    }
    if (!resumed) {
      feed(socket, "started", new ArrayBuffer(4));
      expectPlayback(ctx, "starting", 0);
      expect(actions()).toEqual(pending);
      deferred.resolve();
      await Promise.resolve();
    }
    expect(actions()).toEqual([...pending, "start"]);
    // Unacknowledged PCM must not seed the fresh capture's stereo remainder.
    feed(socket, [255, 127, 0]);
    expectPlayback(ctx, "starting", 0);
    feed(socket, "started", [0, 128, 255, 127, 0, 64, 0, 192]);
    expectPlayback(ctx, "playing", 1);
    expectSamples([
      [-1, 0.5],
      [32767 / 32768, -0.5],
    ]);
    expect(previous.sources).toHaveLength(playing ? 1 : 0);
    expect(previous.close).toHaveBeenCalledOnce();
  },
);

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
    feed(socket, state);
    expect(audio.state()).toBe("error");
    feed(socket, "started", new ArrayBuffer(4), "stopped", "started", new ArrayBuffer(4));
    expect(audio.state()).toBe("error");
    expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
    expect(AudioContextMock.instances[0]!.sources).toHaveLength(playing ? 1 : 0);
  },
);

it("reports unsupported audio without opening a socket", () => {
  vi.stubGlobal("AudioContext", undefined);
  audio.connect({ audio: desktopAudioStream }, "wss://gateway.test");
  expect(audio.state()).toBe("unsupported");
  expect(AudioSocketMock.instances).toHaveLength(0);
});
