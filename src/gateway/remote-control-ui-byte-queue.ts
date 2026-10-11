import { isUint8Array } from "node:util/types";

/** Match the byte-oriented chunks accepted by Node HTTP and stream writers. */
export function remoteControlUiChunkBytes(chunk: unknown, encoding?: BufferEncoding): number {
  return typeof chunk === "string"
    ? Buffer.byteLength(chunk, encoding)
    : isUint8Array(chunk)
      ? chunk.byteLength
      : 0;
}

export function createRemoteControlUiByteQueue(params: {
  assertCurrent: () => void;
  reserveBytes: (bytes: number) => () => void;
}) {
  const reservations: { remaining: number; release: () => void }[] = [];
  let disposed = false;
  return {
    retain(bytes: number) {
      params.assertCurrent();
      if (disposed) {
        throw new Error("Remote Control UI transport buffer is closed");
      }
      if (bytes > 0) {
        reservations.push({ remaining: bytes, release: params.reserveBytes(bytes) });
      }
    },
    consume(bytes: number) {
      let remaining = bytes;
      while (remaining > 0) {
        const reservation = reservations[0];
        if (!reservation) {
          return;
        }
        const consumed = Math.min(remaining, reservation.remaining);
        reservation.remaining -= consumed;
        remaining -= consumed;
        if (reservation.remaining === 0) {
          reservations.shift();
          reservation.release();
        }
      }
    },
    dispose() {
      disposed = true;
      for (const reservation of reservations.splice(0)) {
        reservation.release();
      }
    },
  };
}
