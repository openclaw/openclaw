/**
 * Native media forwarding store.
 *
 * When `tools.media.audio.nativeForwarding` or `tools.media.video.nativeForwarding`
 * is enabled, the raw attachment bytes are captured here during media understanding
 * and later consumed at prompt time so multimodal models receive the original audio/video
 * alongside the text transcription/description.
 *
 * The store is keyed by a caller-provided session/run id so concurrent runs don't
 * collide.  Entries are consumed (deleted) on read to avoid unbounded memory growth.
 */

import type { NativeMediaBlock } from "./types.js";

const store = new Map<string, NativeMediaBlock[]>();

/**
 * Append native media blocks for a given context key (typically `runId` or `sessionId`).
 */
export function pushNativeMediaBlocks(key: string, blocks: NativeMediaBlock[]): void {
  if (!blocks || blocks.length === 0) {
    return;
  }
  const existing = store.get(key) ?? [];
  existing.push(...blocks);
  store.set(key, existing);
}

/**
 * Consume (pop) all pending native media blocks for a context key.
 * Returns an empty array when nothing is pending.  The entry is deleted
 * after consumption so memory is freed promptly.
 */
export function consumeNativeMediaBlocks(key: string): NativeMediaBlock[] {
  const blocks = store.get(key);
  if (!blocks || blocks.length === 0) {
    store.delete(key);
    return [];
  }
  store.delete(key);
  return blocks;
}

/**
 * Discard any pending native media blocks for a context key (cleanup on error paths).
 */
export function discardNativeMediaBlocks(key: string): void {
  store.delete(key);
}
