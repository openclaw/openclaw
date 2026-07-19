/**
 * Bounded audio chunk queue used by the meeting-bridge node host.
 *
 * The session's chunk buffer was previously only bounded by element count
 * (200 chunks), which allowed a single chatty producer emitting very large
 * chunks to grow the in-memory queue without bound: a producer pushing
 * 10 MiB chunks would retain up to 2 GiB of audio. This helper trims by
 * both chunk count and total byte size so neither dimension can run away.
 */
export const DEFAULT_MAX_AUDIO_CHUNKS = 200;
/**
 * Safety bound for buffered audio, in bytes. ~32 MiB 鈮?8 seconds of
 * 16-bit 44.1 kHz stereo audio, which is far above any legitimate back-log
 * but small enough to keep the host's footprint predictable.
 */
export const DEFAULT_MAX_AUDIO_QUEUE_BYTES = 32 * 1024 * 1024;

export type AudioChunkQueueLimits = {
  maxChunks: number;
  maxBytes: number;
};

export type AudioChunkQueue = {
  chunks: Buffer[];
  bytes: number;
};

export function createAudioChunkQueue(): AudioChunkQueue {
  return { chunks: [], bytes: 0 };
}

/** Append a chunk and trim the queue so it stays within `maxChunks` and `maxBytes`. */
export function appendAudioChunk(
  queue: AudioChunkQueue,
  chunk: Buffer,
  limits: AudioChunkQueueLimits,
): void {
  queue.chunks.push(chunk);
  queue.bytes += chunk.byteLength;
  while (queue.chunks.length > limits.maxChunks || queue.bytes > limits.maxBytes) {
    const dropped = queue.chunks.shift();
    if (dropped) {
      queue.bytes -= dropped.byteLength;
    }
  }
}

/** Remove and return the oldest chunk, keeping the running byte counter in sync. */
export function takeAudioChunk(queue: AudioChunkQueue): Buffer | undefined {
  const chunk = queue.chunks.shift();
  if (chunk) {
    queue.bytes -= chunk.byteLength;
  }
  return chunk;
}
