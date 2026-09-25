/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  AudioContextMock,
  AudioSocketMock,
  desktopAudioStream,
  stubDesktopAudio,
} from "./desktop-audio.test-support.ts";
import { DesktopAudio } from "./desktop-audio.ts";

describe("desktop audio connection", () => {
  let audio: DesktopAudio;
  beforeEach(() => {
    stubDesktopAudio();
    audio = new DesktopAudio(
      {
        ownerDocument: document,
        embedded: false,
        presented: false,
        documentMode: false,
        addController: vi.fn(),
        removeController: vi.fn(),
        requestUpdate: vi.fn(),
        updateComplete: Promise.resolve(true),
      },
      () => true,
      vi.fn(),
    );
  });
  afterEach(() => {
    audio.close();
    vi.unstubAllGlobals();
  });
  function connect() {
    audio.connect({ audio: desktopAudioStream }, "wss://gateway.test/base/");
    const socket = AudioSocketMock.instances.at(-1)!;
    socket.open();
    return socket;
  }

  it("opens muted, resumes synchronously on unmute, and stops capture and samples on mute", async () => {
    const socket = connect();
    expect(socket.url).toBe("wss://gateway.test/desktop/audio");
    expect(socket.binaryType).toBe("arraybuffer");
    expect(audio.state).toBe("muted");
    expect(AudioContextMock.instances).toHaveLength(0);
    expect(socket.send).not.toHaveBeenCalled();
    socket.message(new ArrayBuffer(4));
    audio.unmute();
    const context = AudioContextMock.instances[0]!;
    expect(context.resume).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(socket.send).toHaveBeenCalledWith('{"action":"start"}');
    expect(audio.state).toBe("starting");
    socket.message(new ArrayBuffer(4));
    expect(context.sources).toHaveLength(0);
    socket.message('{"state":"started"}');
    expect(audio.state).toBe("playing");
    socket.message(new ArrayBuffer(4));
    expect(context.sources).toHaveLength(1);
    audio.mute();
    expect(socket.send).toHaveBeenLastCalledWith('{"action":"stop"}');
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.sources[0]!.stop).toHaveBeenCalledOnce();
    socket.message(new ArrayBuffer(4));
    socket.message('{"state":"started"}');
    expect(audio.state).toBe("muted");
    expect(context.sources).toHaveLength(1);
  });

  it.each(["mute", "close", "replace"])(
    "rejects late resume completion after %s",
    async (action) => {
      const deferred = createDeferred();
      vi.stubGlobal(
        "AudioContext",
        class extends AudioContextMock {
          override resume = vi.fn(() => deferred.promise);
        },
      );
      const socket = connect();
      const lateMessage = socket.captureDispatch("message");
      const lateError = socket.captureDispatch("error");
      const lateOpen = socket.captureDispatch("open");
      const lateClose = socket.captureDispatch("close");
      expect(socket.listenerCount).toBe(4);
      audio.unmute();
      if (action === "mute") {
        audio.mute();
      } else if (action === "close") {
        audio.close();
      } else {
        connect();
      }
      deferred.resolve();
      await Promise.resolve();
      expect(socket.send).not.toHaveBeenCalledWith('{"action":"start"}');
      expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
      if (action !== "mute") {
        expect(socket.listenerCount).toBe(0);
        lateMessage(new MessageEvent("message", { data: new ArrayBuffer(4) }));
        lateError(new Event("error"));
        lateOpen(new Event("open"));
        lateClose(new Event("close"));
        expect(audio.state).toBe(action === "replace" ? "muted" : "unavailable");
        expect(socket.close).toHaveBeenCalledOnce();
        if (action === "replace") {
          const replacement = AudioSocketMock.instances.at(-1)!;
          expect(replacement.listenerCount).toBe(4);
          audio.unmute();
          deferred.resolve();
          await Promise.resolve();
          replacement.message('{"state":"started"}');
          expect(audio.state).toBe("playing");
          audio.close();
          expect(replacement.listenerCount).toBe(0);
        }
      }
    },
  );

  it("shows blocked playback and allows a new user gesture without autoplay", async () => {
    vi.stubGlobal(
      "AudioContext",
      class extends AudioContextMock {
        override resume = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
      },
    );
    const socket = connect();
    audio.unmute();
    await Promise.resolve();
    expect(audio.state).toBe("blocked");
    expect(socket.send).not.toHaveBeenCalledWith('{"action":"start"}');
    socket.message('{"state":"stopped"}');
    vi.stubGlobal("AudioContext", AudioContextMock);
    audio.unmute();
    await Promise.resolve();
    socket.message('{"state":"started"}');
    expect(audio.state).toBe("playing");
  });

  it.each(["started", "error", "canceled"])(
    "ignores a superseded %s start and old PCM until the fresh start acknowledgment",
    async (oldStatus) => {
      const socket = connect();
      audio.unmute();
      await Promise.resolve();
      audio.mute();
      audio.unmute();
      await Promise.resolve();
      const context = AudioContextMock.instances.at(-1)!;
      expect(socket.send.mock.calls.map(([text]) => JSON.parse(text).action)).toEqual([
        "start",
        "stop",
      ]);
      if (oldStatus !== "canceled") {
        socket.message(JSON.stringify({ state: oldStatus }));
      }
      socket.message(new Uint8Array([255, 127, 0]).buffer);
      socket.message(new ArrayBuffer(4));
      expect(audio.state).toBe("starting");
      expect(context.sources).toHaveLength(0);
      socket.message('{"state":"stopped"}');
      expect(socket.send.mock.calls.map(([text]) => JSON.parse(text).action)).toEqual([
        "start",
        "stop",
        "start",
      ]);
      // Even after sending start, an unacknowledged three-byte stereo tail
      // must never become the new capture's sample remainder.
      socket.message(new Uint8Array([255, 127, 0]).buffer);
      expect(audio.state).toBe("starting");
      expect(context.sources).toHaveLength(0);
      socket.message('{"state":"started"}');
      socket.message(new Uint8Array([0, 128, 255, 127, 0, 64, 0, 192]).buffer);
      expect(audio.state).toBe("playing");
      expect(context.sources).toHaveLength(1);
      expect(Array.from(context.sources[0]!.buffer!.getChannelData(0))).toEqual([-1, 0.5]);
      expect(Array.from(context.sources[0]!.buffer!.getChannelData(1))).toEqual([
        32767 / 32768,
        -0.5,
      ]);
      expect(AudioContextMock.instances[0]!.sources).toHaveLength(0);
      expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
    },
  );

  it("waits for every stop barrier after repeated mute/unmute before starting capture", async () => {
    const socket = connect();
    audio.unmute();
    await Promise.resolve();
    socket.message('{"state":"started"}');
    socket.message(new ArrayBuffer(4));
    const oldContext = AudioContextMock.instances[0]!;
    audio.mute();
    audio.unmute();
    await Promise.resolve();
    audio.mute();
    audio.unmute();
    await Promise.resolve();
    expect(oldContext.sources[0]!.stop).toHaveBeenCalledOnce();
    expect(oldContext.close).toHaveBeenCalledOnce();
    socket.message('{"state":"error"}');
    socket.message('{"state":"stopped"}');
    expect(socket.send).toHaveBeenCalledTimes(3);
    socket.message('{"state":"started"}');
    socket.message(new ArrayBuffer(4));
    expect(AudioContextMock.instances.at(-1)!.sources).toHaveLength(0);
    socket.message('{"state":"stopped"}');
    expect(socket.send).toHaveBeenCalledTimes(4);
    socket.message('{"state":"started"}');
    socket.message(new ArrayBuffer(4));
    expect(audio.state).toBe("playing");
    expect(AudioContextMock.instances.at(-1)!.sources).toHaveLength(1);
    expect(oldContext.sources).toHaveLength(1);
  });

  it("does not let a stop acknowledgment bypass a pending browser resume", async () => {
    const socket = connect();
    audio.mute();
    const deferred = createDeferred();
    vi.stubGlobal(
      "AudioContext",
      class extends AudioContextMock {
        override resume = vi.fn(() => deferred.promise);
      },
    );
    audio.unmute();
    socket.message('{"state":"stopped"}');
    socket.message('{"state":"started"}');
    socket.message(new ArrayBuffer(4));
    expect(socket.send).not.toHaveBeenCalledWith('{"action":"start"}');
    expect(AudioContextMock.instances[0]!.sources).toHaveLength(0);
    deferred.resolve();
    await Promise.resolve();
    expect(socket.send).toHaveBeenLastCalledWith('{"action":"start"}');
    expect(audio.state).toBe("starting");
    socket.message('{"state":"started"}');
    expect(audio.state).toBe("playing");
  });

  it.each(["error", "stopped"])("silences samples on server %s", async (state) => {
    const socket = connect();
    audio.unmute();
    await Promise.resolve();
    socket.message('{"state":"started"}');
    socket.message(new ArrayBuffer(4));
    socket.message(JSON.stringify({ state, message: "capture failed" }));
    expect(audio.state).toBe("error");
    expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
  });

  it("reports capture failure while awaiting started and ignores its late acknowledgment", async () => {
    const socket = connect();
    audio.unmute();
    await Promise.resolve();
    socket.message('{"state":"error"}');
    expect(audio.state).toBe("error");
    socket.message('{"state":"started"}');
    socket.message(new ArrayBuffer(4));
    socket.message('{"state":"stopped"}');
    socket.message('{"state":"started"}');
    socket.message(new ArrayBuffer(4));
    expect(audio.state).toBe("error");
    expect(AudioContextMock.instances[0]!.close).toHaveBeenCalledOnce();
    expect(AudioContextMock.instances[0]!.sources).toHaveLength(0);
  });

  it("removes visibility listeners on detach and reattaches exactly once", () => {
    const retire = vi.spyOn(audio, "retire");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    audio.hostConnected();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(retire).toHaveBeenCalledTimes(1);
    audio.hostDisconnected();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(retire).toHaveBeenCalledTimes(1);
    audio.hostConnected();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(retire).toHaveBeenCalledTimes(2);
    audio.hostDisconnected();
    hidden.mockRestore();
    retire.mockRestore();
  });

  it("reports unsupported and absent audio without opening a socket", () => {
    audio.connect({}, "wss://gateway.test");
    expect(audio.state).toBe("unavailable");
    vi.stubGlobal("AudioContext", undefined);
    audio.connect({ audio: desktopAudioStream }, "wss://gateway.test");
    expect(audio.state).toBe("unsupported");
    expect(AudioSocketMock.instances).toHaveLength(0);
  });
});
