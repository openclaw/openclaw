import type { Writable } from "node:stream";
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
  stream.once("finish", () => {
    ended = true;
  });
  stream.once("close", () => {
    ended = true;
    destroyed = true;
  });
  stream.once("error", () => {
    destroyed = true;
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
        stream.write(data, callback);
      } catch (error) {
        callback?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    end() {
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
      try {
        stream.destroy();
      } catch {
        // Destroying an already-failed child pipe is best effort.
      }
    },
  };
}
