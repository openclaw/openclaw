import { describe, expect, it } from "vitest";
import { AudioContextMock } from "./desktop-pcm-queue.test-support.ts";
import { DesktopPcmQueue } from "./desktop-pcm-queue.ts";

describe("desktop PCM playback", () => {
  it("preserves signed little-endian stereo alignment across every byte split", () => {
    const bytes = new Uint8Array([0, 128, 255, 127, 0, 64, 0, 192]);
    for (let split = 1; split < bytes.length; split += 1) {
      const context = new AudioContextMock();
      const queue = new DesktopPcmQueue(context as unknown as AudioContext);
      queue.play(bytes.subarray(0, split));
      queue.play(bytes.subarray(split));
      expect(context.sources.flatMap((s) => Array.from(s.buffer!.getChannelData(0)))).toEqual([
        -1, 0.5,
      ]);
      expect(context.sources.flatMap((s) => Array.from(s.buffer!.getChannelData(1)))).toEqual([
        32767 / 32768,
        -0.5,
      ]);
      queue.stop();
    }
  });

  it("drops old sources at 250ms and trims oversized chunks to their freshest frames", () => {
    const context = new AudioContextMock();
    const queue = new DesktopPcmQueue(context as unknown as AudioContext);
    queue.play(new Uint8Array(4800 * 4));
    queue.play(new Uint8Array(4800 * 4));
    const ended = context.sources[0]!.captureDispatch("ended");
    queue.play(new Uint8Array(4800 * 4));
    expect(context.sources.slice(0, 2).every((s) => s.stop.mock.calls.length === 1)).toBe(true);
    expect(context.sources[2]!.start).toHaveBeenCalledWith(0);
    expect(context.sources[0]!.listenerCount).toBe(0);
    ended(new Event("ended"));
    expect(context.sources[0]!.disconnect).toHaveBeenCalledOnce();
    expect(context.sources[2]!.stop).not.toHaveBeenCalled();
    const large = new Uint8Array(24000 * 4 + 1);
    large[12000 * 4 + 1] = 64;
    large[large.length - 1] = 255;
    queue.play(large);
    const newest = context.sources.at(-1)!;
    expect(newest.buffer!.duration).toBe(0.25);
    expect(newest.buffer!.getChannelData(0)[0]).toBe(0.5);
    queue.play(new Uint8Array([127, 0, 128]));
    expect(context.sources.at(-1)!.buffer!.getChannelData(0)[0]).toBe(32767 / 32768);
    expect(context.sources.at(-1)!.buffer!.getChannelData(1)[0]).toBe(-1);
    queue.stop();
  });

  it("releases a naturally ended source and its listener without stopping it again", () => {
    const context = new AudioContextMock();
    const queue = new DesktopPcmQueue(context as unknown as AudioContext);
    queue.play(new Uint8Array(4));
    const source = context.sources[0]!;
    expect(source.listenerCount).toBe(1);
    source.dispatchEvent(new Event("ended"));
    expect(source.listenerCount).toBe(0);
    expect(source.disconnect).toHaveBeenCalledOnce();
    queue.stop();
    expect(source.stop).not.toHaveBeenCalled();
    expect(source.disconnect).toHaveBeenCalledOnce();
  });

  it("bounds live source count for tiny chunks and clears incomplete frames on stop", () => {
    const context = new AudioContextMock();
    const queue = new DesktopPcmQueue(context as unknown as AudioContext);
    for (let i = 0; i < 100; i += 1) {
      queue.play(new Uint8Array(4));
      expect(
        context.sources.filter((s) => s.stop.mock.calls.length === 0).length,
      ).toBeLessThanOrEqual(32);
    }
    queue.play(new Uint8Array([255, 127, 0]));
    queue.stop();
    expect(context.sources.every((s) => s.disconnect.mock.calls.length > 0)).toBe(true);
    expect(context.sources.every((s) => s.listenerCount === 0)).toBe(true);
    queue.play(new Uint8Array([0, 128, 0, 64]));
    expect(context.sources.at(-1)!.buffer!.getChannelData(0)[0]).toBe(-1);
    expect(context.sources.at(-1)!.buffer!.getChannelData(1)[0]).toBe(0.5);
    queue.stop();
  });
});
