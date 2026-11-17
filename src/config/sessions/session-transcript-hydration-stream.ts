import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import type { SessionTranscriptHydrationChunk } from "./session-transcript-hydration.types.js";

export const SESSION_TRANSCRIPT_SLICE_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const CHUNK_FRAMES = 128;

export type SessionTranscriptHydrationConsumer = (
  chunk: SessionTranscriptHydrationChunk,
  transfers: ArrayBuffer[],
) => void | Promise<void>;

/** One framing owner for native row bytes and already-selected retained entries. */
export function createSessionTranscriptHydrationStream(
  encoding: string,
  consume: SessionTranscriptHydrationConsumer,
  control: WorkerTaskControl,
) {
  let frames: SessionTranscriptHydrationChunk["frames"] = [];
  let transfers: ArrayBuffer[] = [];
  let bytes = 0;
  let eventCount = 0;
  const flush = async () => {
    if (!frames.length) {
      return;
    }
    control.throwIfCancelled();
    await consume({ kind: "transcript-hydration-chunk", encoding, frames }, transfers);
    frames = [];
    transfers = [];
    bytes = 0;
    control.throwIfCancelled();
  };
  const writeFrame = (
    frame: SessionTranscriptHydrationChunk["frames"][number],
    transfer?: ArrayBuffer,
  ): void | Promise<void> => {
    control.throwIfCancelled();
    if (frames.length && bytes + frame.data.byteLength > CHUNK_BYTES) {
      return flush().then(() => writeFrame(frame, transfer));
    }
    if (transfer) {
      transfers.push(transfer);
    }
    frames.push(frame);
    bytes += frame.data.byteLength;
    if (frame.endOfEvent) {
      eventCount++;
    }
    if (bytes >= CHUNK_BYTES || frames.length >= CHUNK_FRAMES) {
      return flush();
    }
  };
  const encoder = new TextEncoder();
  return {
    writeFrame,
    async writeJsonEvent(value: unknown) {
      const encoded = encoder.encode(JSON.stringify(value));
      for (let offset = 0; ; offset += SESSION_TRANSCRIPT_SLICE_BYTES) {
        const data = encoded.slice(offset, offset + SESSION_TRANSCRIPT_SLICE_BYTES);
        const endOfEvent = data.byteLength < SESSION_TRANSCRIPT_SLICE_BYTES;
        const pending = writeFrame({ data, endOfEvent }, data.buffer);
        if (pending) {
          await pending;
        }
        if (endOfEvent) {
          return;
        }
      }
    },
    async finish() {
      await flush();
      control.throwIfCancelled();
      return eventCount;
    },
  };
}
