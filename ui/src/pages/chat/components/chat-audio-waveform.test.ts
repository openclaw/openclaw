// @vitest-environment node
import { expect, it } from "vitest";
import {
  cacheAndRetainChatAudioBlob,
  CHAT_AUDIO_WAVEFORM_MAX_BYTES,
  computeChatAudioWaveformPeaks,
  retainCachedChatAudioBlob,
  shouldFetchChatAudioWaveform,
} from "./chat-audio-waveform.ts";

const retain = (key: string, sizeBytes = 1) =>
  cacheAndRetainChatAudioBlob(key, { blobUrl: `blob:${key}`, sizeBytes });

it("caps waveform decoding by byte size and duration", () => {
  const sizeBytes = CHAT_AUDIO_WAVEFORM_MAX_BYTES;
  expect(shouldFetchChatAudioWaveform({ sizeBytes, durationSeconds: 300 })).toBe(true);
  for (const input of [
    { sizeBytes: sizeBytes + 1 },
    { sizeBytes, durationSeconds: 301 },
    {},
    { sizeBytes },
    { sizeBytes, durationSeconds: Number.NaN },
  ]) {
    expect(shouldFetchChatAudioWaveform(input)).toBe(false);
  }
});

it("normalizes bucket peaks across every channel", () => {
  const channels = [
    [0.1, -0.5, 0.2, 0.4, -0.25, 0.75, 0, -1],
    [0, 0, 1, 0, 0, 0, 0, 2],
  ].map((samples) => Float32Array.from({ length: 192 }, (_, index) => samples[index % 8]!));
  const peaks = computeChatAudioWaveformPeaks({
    length: channels[0]!.length,
    numberOfChannels: channels.length,
    getChannelData: (channel) => channels[channel]!,
  });

  expect(peaks).toEqual(Array.from({ length: 96 }, (_, index) => [0.25, 0.5, 0.375, 1][index % 4]));
});

it("enforces the entry cap until the last lease releases an evictable Blob", () => {
  const releases: Array<() => void> = [];
  for (let index = 0; index < 32; index += 1) {
    const retained = retain(`retained-${index}`);
    expect(retained).not.toBeNull();
    if (!retained) {
      throw new Error("expected retained audio blob");
    }
    expect(retained.value.blobUrl).toBe(`blob:retained-${index}`);
    releases.push(retained.release);
  }
  expect(retain("retained-overflow")).toBeNull();

  const shared = retainCachedChatAudioBlob("retained-0");
  expect(shared).not.toBeNull();
  releases[0]!();
  releases[0]!();
  expect(retain("retained-overflow")).toBeNull();

  shared!.release();
  const replacement = retain("retained-after-release");
  expect(replacement).not.toBeNull();
  expect(retainCachedChatAudioBlob("retained-0")).toBeNull();
  replacement?.release();

  for (const release of releases) {
    release();
  }
});

it("caps retained audio bytes at 48 MiB", () => {
  const releases = Array.from({ length: 6 }, (_, index) =>
    retain(`large-${index}`, CHAT_AUDIO_WAVEFORM_MAX_BYTES),
  );
  expect(releases.every((retained) => retained !== null)).toBe(true);
  expect(retain("large-overflow", CHAT_AUDIO_WAVEFORM_MAX_BYTES)).toBeNull();
  for (const retained of releases) {
    retained?.release();
  }
});
