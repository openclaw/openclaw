import { describe, expect, it } from "vitest";
import {
  appendAudioChunk,
  createAudioChunkQueue,
  DEFAULT_MAX_AUDIO_CHUNKS,
  DEFAULT_MAX_AUDIO_QUEUE_BYTES,
  takeAudioChunk,
} from "./node-audio-chunk-queue.js";

describe("appendAudioChunk", () => {
  it("returns the queue untouched when under both limits", () => {
    const queue = createAudioChunkQueue();
    appendAudioChunk(queue, Buffer.from("hello"), {
      maxChunks: 10,
      maxBytes: 1024,
    });
    expect(queue.chunks.map((c) => c.toString())).toEqual(["hello"]);
    expect(queue.bytes).toBe(5);
  });

  it("trims oldest chunks when chunk count exceeds the limit", () => {
    const queue = createAudioChunkQueue();
    const limits = { maxChunks: 2, maxBytes: 1024 * 1024 };
    for (let i = 0; i < 5; i += 1) {
      appendAudioChunk(queue, Buffer.from(`c${i}`), limits);
    }
    expect(queue.chunks.map((c) => c.toString())).toEqual(["c3", "c4"]);
    expect(queue.bytes).toBe(4);
  });

  it("trims oldest chunks when total bytes exceed the limit", () => {
    const queue = createAudioChunkQueue();
    const limits = { maxChunks: 1000, maxBytes: 8 };
    appendAudioChunk(queue, Buffer.alloc(5), limits);
    appendAudioChunk(queue, Buffer.alloc(5), limits);
    appendAudioChunk(queue, Buffer.alloc(5), limits);
    // The first two 5-byte chunks push us over the 8-byte limit; both are
    // dropped on the third append so the queue only holds the most recent.
    expect(queue.chunks).toHaveLength(1);
    expect(queue.bytes).toBe(5);
  });

  it("honors both limits simultaneously", () => {
    const queue = createAudioChunkQueue();
    const limits = { maxChunks: 3, maxBytes: 6 };
    for (let i = 0; i < 5; i += 1) {
      appendAudioChunk(queue, Buffer.alloc(2), limits);
    }
    expect(queue.chunks).toHaveLength(3);
    expect(queue.bytes).toBe(6);
  });
});

describe("takeAudioChunk", () => {
  it("returns undefined for an empty queue and leaves bytes at zero", () => {
    const queue = createAudioChunkQueue();
    expect(takeAudioChunk(queue)).toBeUndefined();
    expect(queue.bytes).toBe(0);
  });

  it("removes the oldest chunk and decrements the byte counter", () => {
    const queue = createAudioChunkQueue();
    appendAudioChunk(
      queue,
      Buffer.from("abcd"),
      { maxChunks: 10, maxBytes: 1024 },
    );
    appendAudioChunk(
      queue,
      Buffer.from("efghij"),
      { maxChunks: 10, maxBytes: 1024 },
    );
    expect(queue.bytes).toBe(10);
    const first = takeAudioChunk(queue);
    expect(first?.toString()).toBe("abcd");
    expect(queue.chunks.map((c) => c.toString())).toEqual(["efghij"]);
    expect(queue.bytes).toBe(6);
  });
});

describe("audio chunk queue defaults", () => {
  it("exposes the production limits used by the node host", () => {
    // Sanity-check the production defaults so an accidental unit change is
    // caught at review time.
    expect(DEFAULT_MAX_AUDIO_CHUNKS).toBe(200);
    expect(DEFAULT_MAX_AUDIO_QUEUE_BYTES).toBe(32 * 1024 * 1024);
  });
});
