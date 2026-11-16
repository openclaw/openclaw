import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import type { SessionTranscriptHydrationChunk } from "./session-transcript-hydration.types.js";

export const SESSION_TRANSCRIPT_SLICE_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const CHUNK_FRAMES = 128;

export type SessionTranscriptHydrationConsumer = (
  chunk: SessionTranscriptHydrationChunk,
  transfers: ArrayBuffer[],
) => void | Promise<void>;

/** One framing owner for native row bytes; the consumer owns acknowledged delivery. */
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
  return {
    writeFrame,
    async finish() {
      await flush();
      control.throwIfCancelled();
      return eventCount;
    },
  };
}
