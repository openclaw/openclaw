/**
 * Real-time PCM audio output buffer — Phase A.2 of streaming multimodal.
 *
 * Tracks streaming audio chunks delivered by the LLM provider and
 * exposes a virtual playback timeline used for barge-in / truncate
 * calculations (Phase B). Storage is opaque (provider-encoded chunks
 * are kept verbatim) so this works for both raw PCM and base64 payloads.
 *
 * See ../../../.orchestration/streaming-multimodal-prep/ARCHITECTURE.md §3.2.2.
 */

/** A single streamed audio chunk produced by the LLM. */
export interface OutputAudioChunk {
  /** Opaque payload (e.g. base64-encoded PCM16, or raw bytes). */
  readonly payload: string | Buffer;
  /** Duration of this chunk in milliseconds. */
  readonly durationMs: number;
  /** Cumulative timeline offset (ms) where this chunk *starts*. */
  readonly startMs: number;
  /** Cumulative timeline offset (ms) where this chunk *ends* (start + duration). */
  readonly endMs: number;
}

/** Result of a truncate operation (used to inform the LLM via conversation.item.truncate). */
export interface TruncateResult {
  /**
   * Audio end position in ms — passed to the provider's truncate event so
   * the model knows how much of the response was actually heard.
   */
  audioEndMs: number;
  /** Number of chunks removed from the queue. */
  chunksDropped: number;
  /** Total milliseconds of audio dropped. */
  msDropped: number;
}

/** Configuration knobs. */
export interface RealtimeOutputBufferOptions {
  /** Optional clock injector (test seam). */
  now?: () => number;
}

/**
 * RealtimeOutputBuffer — accept LLM audio deltas, expose a playback
 * timeline, and allow the head of the queue to be flushed to the client
 * or truncated when the user barges in.
 */
export class RealtimeOutputBuffer {
  private readonly chunks: OutputAudioChunk[] = [];
  /** Total ms enqueued ever (monotonic; not decremented on flush/truncate). */
  private totalEnqueuedMs = 0;
  /** Wall-clock ms at which playback nominally began (when first chunk enqueued). */
  private playbackStartedAt: number | null = null;
  /**
   * After truncate, force the playback position to this absolute timeline ms.
   * `null` means "compute from clock + start time".
   */
  private playbackOverrideMs: number | null = null;
  private readonly clock: () => number;

  constructor(options: RealtimeOutputBufferOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
  }

  /**
   * Enqueue a streamed chunk. `durationMs` must be non-negative.
   *
   * Returns the chunk descriptor with assigned start/end timeline offsets.
   */
  enqueueChunk(payload: string | Buffer, durationMs: number): OutputAudioChunk {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError(
        `[RealtimeOutputBuffer.enqueueChunk] durationMs must be a non-negative finite number (got ${durationMs})`,
      );
    }
    const startMs = this.totalEnqueuedMs;
    const endMs = startMs + durationMs;
    const chunk: OutputAudioChunk = { payload, durationMs, startMs, endMs };
    this.chunks.push(chunk);
    this.totalEnqueuedMs = endMs;
    if (this.playbackStartedAt == null) {
      this.playbackStartedAt = this.clock();
    }
    return chunk;
  }

  /** Total ms of audio ever enqueued (monotonic). */
  getTotalEnqueuedMs(): number {
    return this.totalEnqueuedMs;
  }

  /** Number of chunks currently queued (not yet flushed). */
  getQueueLength(): number {
    return this.chunks.length;
  }

  /**
   * Estimated playback position in ms along the timeline. Reflects
   * wall-clock advancement since the first chunk was enqueued, capped at
   * `totalEnqueuedMs`. After truncate, returns the truncated position.
   */
  getPlaybackPosition(): number {
    if (this.playbackOverrideMs != null) {
      return this.playbackOverrideMs;
    }
    if (this.playbackStartedAt == null) {
      return 0;
    }
    const elapsed = this.clock() - this.playbackStartedAt;
    if (elapsed <= 0) {
      return 0;
    }
    return Math.min(elapsed, this.totalEnqueuedMs);
  }

  /**
   * Drain queued chunks up to the head; consumer is responsible for
   * shipping them to the client. Returns chunks in order and removes them
   * from the queue. Does NOT touch the playback timeline.
   */
  flush(): OutputAudioChunk[] {
    const drained = this.chunks.splice(0);
    return drained;
  }

  /**
   * Truncate audio after `audioEndMs` along the timeline. Drops any
   * chunks (or chunk tails) whose start exceeds the cutoff and pins the
   * reported playback position to that cutoff.
   *
   * Returns metadata suitable for forwarding to the provider's
   * `conversation.item.truncate` event.
   */
  truncate(audioEndMs: number): TruncateResult {
    if (!Number.isFinite(audioEndMs) || audioEndMs < 0) {
      throw new RangeError(
        `[RealtimeOutputBuffer.truncate] audioEndMs must be a non-negative finite number (got ${audioEndMs})`,
      );
    }
    const cutoff = Math.min(audioEndMs, this.totalEnqueuedMs);
    let chunksDropped = 0;
    let msDropped = 0;

    // Drop trailing chunks whose start is at/after the cutoff.
    while (this.chunks.length > 0) {
      const last = this.chunks[this.chunks.length - 1];
      if (last.startMs >= cutoff) {
        this.chunks.pop();
        chunksDropped++;
        msDropped += last.durationMs;
        continue;
      }
      // Possible partial-tail trim of the boundary chunk.
      if (last.endMs > cutoff) {
        const trimmedDuration = cutoff - last.startMs;
        const droppedTail = last.endMs - cutoff;
        msDropped += droppedTail;
        // Replace with shortened chunk preserving identity of payload (caller
        // can decide whether to actually re-encode the audio bytes).
        this.chunks[this.chunks.length - 1] = {
          payload: last.payload,
          durationMs: trimmedDuration,
          startMs: last.startMs,
          endMs: cutoff,
        };
      }
      break;
    }

    this.totalEnqueuedMs = cutoff;
    this.playbackOverrideMs = cutoff;
    return { audioEndMs: cutoff, chunksDropped, msDropped };
  }

  /**
   * Reset the buffer to an empty / fresh state (used when starting a new
   * response turn).
   */
  reset(): void {
    this.chunks.length = 0;
    this.totalEnqueuedMs = 0;
    this.playbackStartedAt = null;
    this.playbackOverrideMs = null;
  }

  /** Snapshot of the current chunk queue (read-only, defensive copy). */
  peekQueue(): readonly OutputAudioChunk[] {
    return this.chunks.slice();
  }
}
