import { afterEach, expect, it, vi } from "vitest";
import type { MediaUnderstandingOutput } from "../../packages/media-understanding-common/src/types.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { shareAudioTranscription } from "./audio-transcription-cache.js";

const output: MediaUnderstandingOutput = {
  kind: "audio.transcription",
  attachmentIndex: 3,
  text: "hello",
  provider: "fixture",
  model: "fixture",
};
afterEach(() => vi.useRealTimers());

it("joins in-flight work and retains only an immutable index-free result", async () => {
  const generation = {};
  const ready = createDeferred<MediaUnderstandingOutput>();
  const transcribe = vi.fn(() => ready.promise);
  const first = shareAudioTranscription(generation, "voice", transcribe);
  const second = shareAudioTranscription(generation, "voice", transcribe);
  await Promise.resolve();
  expect(transcribe).toHaveBeenCalledTimes(1);
  ready.resolve(output);
  const results = await Promise.all([first, second]);
  expect(results[0]).toEqual({
    kind: "audio.transcription",
    text: "hello",
    provider: "fixture",
    model: "fixture",
  });
  expect(Object.isFrozen(results[0])).toBe(true);
  expect(results[1]).toBe(results[0]);
  expect(await shareAudioTranscription(generation, "voice", transcribe)).toBe(results[0]);
  expect(transcribe).toHaveBeenCalledTimes(1);
});

it("expires successful results after fifteen seconds without extending on reads", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  const generation = {};
  const transcribe = vi.fn(async () => output);
  await shareAudioTranscription(generation, "voice", transcribe);
  vi.setSystemTime(14_999);
  await shareAudioTranscription(generation, "voice", transcribe);
  expect(transcribe).toHaveBeenCalledTimes(1);
  vi.setSystemTime(15_000);
  await shareAudioTranscription(generation, "voice", transcribe);
  expect(transcribe).toHaveBeenCalledTimes(2);
});

it("does not reuse transcripts across runtime config generations or request keys", async () => {
  const generation = {};
  const transcribe = vi.fn(async () => output);
  await shareAudioTranscription(generation, "voice", transcribe);
  await shareAudioTranscription({}, "voice", transcribe);
  await shareAudioTranscription(generation, "different-voice", transcribe);
  expect(transcribe).toHaveBeenCalledTimes(3);
});

it.each(["error", "empty", "oversized"] as const)("does not retain %s results", async (kind) => {
  const generation = {};
  const transcribe = vi.fn(async () => {
    if (kind === "error") {
      throw new Error("fixture failed");
    }
    return kind === "empty" ? null : { ...output, text: "x".repeat(65_537) };
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = shareAudioTranscription(generation, "voice", transcribe);
    if (kind === "error") {
      await expect(result).rejects.toThrow("fixture failed");
    } else {
      await result;
    }
  }
  expect(transcribe).toHaveBeenCalledTimes(2);
});

it("bounds pending entries without evicting work that other callers can join", async () => {
  const generation = {};
  const ready = createDeferred<MediaUnderstandingOutput>();
  const transcribe = vi.fn(() => ready.promise);
  const pending = Array.from({ length: 64 }, (_, index) =>
    shareAudioTranscription(generation, String(index), transcribe),
  );
  const overflow = vi.fn(async () => output);
  await shareAudioTranscription(generation, "overflow", overflow);
  await shareAudioTranscription(generation, "overflow", overflow);
  expect(overflow).toHaveBeenCalledTimes(2);
  const joined = shareAudioTranscription(generation, "0", transcribe);
  expect(transcribe).toHaveBeenCalledTimes(64);
  ready.resolve(output);
  await Promise.all([...pending, joined]);
});
