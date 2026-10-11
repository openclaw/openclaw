import { ServerResponse, type IncomingMessage } from "node:http";
import {
  createRemoteControlUiByteQueue,
  remoteControlUiChunkBytes,
} from "./remote-control-ui-byte-queue.js";

type WriteCallback = (error: Error | null | undefined) => void;

/** Account at the producer, before Node's response/socket queues can retain body bytes. */
export function createRemoteControlUiResponseAccounting(params: {
  assertCurrent: () => void;
  reserveBytes: (bytes: number) => () => void;
  abort: (error: unknown) => void;
}) {
  const bytes = createRemoteControlUiByteQueue(params);
  const retain = (response: ServerResponse, chunk: unknown, encoding?: BufferEncoding) => {
    try {
      bytes.retain(remoteControlUiChunkBytes(chunk, encoding));
    } catch (error) {
      params.abort(error);
      // Pipe producers observe cancellation through native stream errors and callbacks.
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  };

  class AccountedResponse<
    Request extends IncomingMessage = IncomingMessage,
  > extends ServerResponse<Request> {
    override write(chunk: unknown, callback?: WriteCallback): boolean;
    override write(chunk: unknown, encoding: BufferEncoding, callback?: WriteCallback): boolean;
    override write(
      chunk: unknown,
      encodingOrCallback?: BufferEncoding | WriteCallback,
      callback?: WriteCallback,
    ): boolean {
      try {
        retain(
          this,
          chunk,
          typeof encodingOrCallback === "string" ? encodingOrCallback : undefined,
        );
        return typeof encodingOrCallback === "string"
          ? super.write(chunk, encodingOrCallback, callback)
          : super.write(chunk, encodingOrCallback ?? callback);
      } catch (error) {
        params.abort(error);
        throw error;
      }
    }

    override end(callback?: () => void): this;
    override end(chunk: unknown, callback?: () => void): this;
    override end(chunk: unknown, encoding: BufferEncoding, callback?: () => void): this;
    override end(
      chunk?: unknown,
      encodingOrCallback?: BufferEncoding | (() => void),
      callback?: () => void,
    ): this {
      try {
        retain(
          this,
          chunk,
          typeof encodingOrCallback === "string" ? encodingOrCallback : undefined,
        );
        return typeof encodingOrCallback === "string"
          ? super.end(chunk, encodingOrCallback, callback)
          : super.end(chunk, encodingOrCallback ?? callback);
      } catch (error) {
        params.abort(error);
        throw error;
      }
    }
  }

  return {
    Response: AccountedResponse,
    consume: (count: number) => bytes.consume(count),
    dispose: () => bytes.dispose(),
  };
}
