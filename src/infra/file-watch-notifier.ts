import type { Writable } from "node:stream";
import { createDeferredCore } from "../shared/deferred.js";

export type FileWatchNotification = "change" | "unavailable" | "available";

/** Same-version watch IPC carries level invalidations, not an event history. */
export function createFileWatchNotifier(output: Writable, onFailure: () => void) {
  // One in-flight line and at most one pending line per kind. Moving repeated
  // kinds to the tail retains the last availability transition after coalescing.
  const pending = new Set<FileWatchNotification>();
  let rejectWrite: ((error: Error) => void) | undefined;
  let accepting = true;
  let writing = false;
  let failure: Error | undefined;
  let draining: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const fail = (cause: unknown) => {
    if (failure) {
      return;
    }
    failure = cause instanceof Error ? cause : new Error("File watch output failed", { cause });
    accepting = false;
    pending.clear();
    rejectWrite?.(failure);
    try {
      onFailure();
    } catch (error) {
      failure = new AggregateError([failure, error], "File watch output retirement failed");
    }
  };
  const onClose = () => {
    if (!accepting && !writing && !pending.size) {
      return;
    }
    fail(new Error("File watch output closed before notification retirement"));
  };
  output.on("error", fail);
  output.on("close", onClose);
  output.on("finish", onClose);
  queueMicrotask(() => {
    if (output.destroyed || output.writableEnded) {
      onClose();
    }
  });
  const pump = () => {
    if (draining || failure || !pending.size) {
      return;
    }
    // Enroll before write callbacks can reenter transport shutdown.
    const done = createDeferredCore();
    draining = done.promise;
    void (async () => {
      while (pending.size) {
        const event = pending.values().next().value!;
        pending.delete(event);
        await new Promise<void>((resolve, reject) => {
          rejectWrite = reject;
          writing = true;
          try {
            output.write(JSON.stringify(event) + "\n", (error) => {
              writing = false;
              rejectWrite = undefined;
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          } catch (error) {
            writing = false;
            rejectWrite = undefined;
            reject(
              error instanceof Error
                ? error
                : new Error("File watch output write failed", { cause: error }),
            );
          }
        });
      }
    })()
      .catch(fail)
      .then(() => {
        draining = undefined;
        rejectWrite = undefined;
        if (pending.size && !failure) {
          pump();
        }
        done.resolve();
      });
  };
  return {
    send(event: FileWatchNotification) {
      if (!accepting) {
        return;
      }
      if (event !== "change" && event !== "available" && event !== "unavailable") {
        throw new TypeError("Unknown file watch notification");
      }
      pending.delete(event);
      pending.add(event);
      pump();
    },
    close(): Promise<void> {
      if (closing) {
        return closing;
      }
      accepting = false;
      closing = Promise.resolve().then(async () => {
        for (let active = draining; active; active = draining) {
          await active;
        }
        // Writable may report the same failure through callback and error event.
        // Consume that queued event before releasing this owner's listeners.
        await new Promise<void>((resolve) => {
          process.nextTick(resolve);
        });
        output.off("error", fail);
        output.off("close", onClose);
        output.off("finish", onClose);
        if (failure) {
          throw failure;
        }
      });
      return closing;
    },
  };
}
