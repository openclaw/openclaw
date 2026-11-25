import type { Writable } from "node:stream";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import type { ManagedRunStdin } from "../types.js";

/** Keep direct children and service relays on the same observable stdin lifecycle. */
export function createManagedChildStdin(
  stream: Writable | null | undefined,
  end: () => void = () => stream?.end(),
  onWriteError?: (error: Error) => void,
): ManagedRunStdin | undefined {
  if (!stream) {
    return undefined;
  }
  let ended = stream.writableEnded || stream.writableFinished;
  let destroyed = stream.destroyed;
  let closedError: NodeJS.ErrnoException | undefined;
  stream.once("finish", () => {
    ended = true;
  });
  stream.once("close", () => {
    ended = true;
    destroyed = true;
  });
  stream.once("error", (error) => {
    destroyed = true;
    onWriteError?.(error);
  });
  return {
    get destroyed() {
      return destroyed || stream.destroyed;
    },
    get writable() {
      return !destroyed && !ended && stream.writable;
    },
    get writableEnded() {
      return ended || stream.writableEnded;
    },
    get writableFinished() {
      return stream.writableFinished;
    },
    write(data, callback) {
      if (destroyed || ended || !stream.writable) {
        const error = Object.assign(new Error("stdin is not writable"), { code: "EPIPE" });
        callback?.(error);
        onWriteError?.(error);
        return;
      }
      try {
        stream.write(data, (error) => {
          // Destroying the relay cancels buffered writes; the remote pipe is already closed.
          const code = extractErrorCode(error);
          callback?.(
            closedError && (code === "ECANCELED" || code === "ERR_STREAM_DESTROYED")
              ? closedError
              : error,
          );
        });
      } catch (error) {
        callback?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    end() {
      // Root exit can close stdin before a caller starts graceful shutdown.
      if (ended || destroyed || stream.destroyed || stream.writableEnded) {
        return;
      }
      ended = true;
      try {
        end();
      } catch {
        // Closing an already-failed child pipe is best effort.
      }
    },
    destroy() {
      ended = true;
      destroyed = true;
      if (onWriteError) {
        closedError ??= Object.assign(new Error("stdin is not writable"), { code: "EPIPE" });
      }
      try {
        stream.destroy(closedError);
      } catch {
        // Destroying an already-failed child pipe is best effort.
      }
    },
  };
}
