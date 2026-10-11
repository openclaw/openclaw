import type { Duplex } from "node:stream";
import {
  createRemoteControlUiByteQueue,
  remoteControlUiChunkBytes,
} from "./remote-control-ui-byte-queue.js";

type WriteCallback = (error: Error | null | undefined) => void;

/** Bound the producer's public write queue until the peer's native parser consumes it. */
export function bindRemoteControlUiSocketBuffer(params: {
  writer: Duplex;
  reader: Duplex;
  assertCurrent: () => void;
  reserveBytes: (bytes: number) => () => void;
  abort: (error: unknown) => void;
}): () => void {
  const bytes = createRemoteControlUiByteQueue(params);
  const write = params.writer.write.bind(params.writer);
  const end = params.writer.end.bind(params.writer);
  const emit = params.reader.emit.bind(params.reader);
  const retain = (chunk: unknown, encoding?: BufferEncoding) => {
    const count = remoteControlUiChunkBytes(chunk, encoding);
    if (count === 0) {
      return;
    }
    try {
      bytes.retain(count);
    } catch (error) {
      params.abort(error);
    }
  };

  function chargedWrite(chunk: unknown, callback?: WriteCallback): boolean;
  function chargedWrite(
    chunk: unknown,
    encoding: BufferEncoding,
    callback?: WriteCallback,
  ): boolean;
  function chargedWrite(
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean {
    try {
      retain(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined);
      return typeof encodingOrCallback === "string"
        ? write(chunk, encodingOrCallback, callback)
        : write(chunk, encodingOrCallback ?? callback);
    } catch (error) {
      params.abort(error);
      throw error;
    }
  }
  function chargedEnd(callback?: () => void): Duplex;
  function chargedEnd(chunk: unknown, callback?: () => void): Duplex;
  function chargedEnd(chunk: unknown, encoding: BufferEncoding, callback?: () => void): Duplex;
  function chargedEnd(
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): Duplex {
    try {
      retain(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined);
      return typeof encodingOrCallback === "string"
        ? end(chunk, encodingOrCallback, callback)
        : end(chunk, encodingOrCallback ?? callback);
    } catch (error) {
      params.abort(error);
      throw error;
    }
  }
  params.writer.write = chargedWrite;
  params.writer.end = chargedEnd;
  // Observe delivery without adding a data listener, which would start the stream before HTTP/ws owns it.
  params.reader.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    try {
      return emit(event, ...args);
    } finally {
      if (event === "data") {
        bytes.consume(remoteControlUiChunkBytes(args[0]));
      }
    }
  };
  return () => bytes.dispose();
}
