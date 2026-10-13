import { Writable, type Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { toErrorObject } from "../infra/errors.js";
import { createWindowsOutputDecoder } from "../infra/windows-encoding.js";
import { createDeferredCore } from "../shared/deferred.js";

export function onDecodedOutput(
  stream: Readable,
  listener: (chunk: string) => void,
  onRaw?: (chunk: Buffer) => void,
): () => void {
  const decoder = createWindowsOutputDecoder();
  const emit = (text: string) => {
    if (text) {
      listener(text);
    }
  };
  let flushed = false;
  const flush = () => {
    if (flushed) {
      return;
    }
    flushed = true;
    emit(decoder.flush());
  };
  const onData = (chunk: Buffer | string) => {
    onRaw?.(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    emit(decoder.decode(chunk));
  };
  stream.on("data", onData);
  stream.once("end", flush);
  stream.once("close", flush);
  return () => {
    // A queued close may still invoke its copied listener, so suppress flush before detaching.
    flushed = true;
    stream.off("data", onData);
    stream.off("end", flush);
    stream.off("close", flush);
  };
}

/** One consumer holds native pipe backpressure until each decoded chunk settles. */
export function createAwaitedDecodedOutput(stream: Readable, onFailure: (error: unknown) => void) {
  type Consumer = (chunk: string) => void | Promise<void>;
  const subscription = createDeferredCore<Consumer | undefined>();
  let subscribed = false;
  let closed = false;
  let decoder: ReturnType<typeof createWindowsOutputDecoder> | undefined;
  let inFlight = Promise.resolve();
  const deliver = (read: () => string, callback: (error?: Error | null) => void) => {
    inFlight = (async () => {
      const listener = await subscription.promise;
      if (closed || !listener) {
        return;
      }
      const text = read();
      if (text) {
        await listener(text);
      }
    })();
    void inFlight.then(
      () => callback(),
      (error: unknown) => callback(toErrorObject(error, "Process stdout consumption failed")),
    );
  };
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      deliver(() => (decoder ??= createWindowsOutputDecoder()).decode(chunk), callback);
    },
    final(callback) {
      deliver(() => decoder?.flush() ?? "", callback);
    },
  });
  const onSourceError = (error: Error) => sink.destroy(error);
  const onSourceClose = () => {
    if (stream.readableEnded) {
      sink.end();
    } else {
      sink.destroy(new Error("Process stdout closed before EOF"));
    }
  };
  stream.once("error", onSourceError);
  stream.once("close", onSourceClose);
  const done = (async () => {
    try {
      // A queued finish can precede destroy's error event; retain its listener through close.
      await finished(sink);
      if (sink.errored) {
        throw sink.errored;
      }
    } catch (error) {
      if (!closed) {
        closed = true;
        try {
          onFailure(error);
        } catch (stopError) {
          throw new AggregateError(
            [error, stopError],
            "Process stdout consumption and stop failed",
            {
              cause: stopError,
            },
          );
        } finally {
          // Stop owns the failure; discard remaining bytes so the native pipe can reach EOF.
          stream.unpipe(sink);
          stream.resume();
        }
      }
      throw error;
    } finally {
      stream.unpipe(sink);
      subscription.resolve(undefined);
      // Destroy may settle the stream before its accepted consumer has returned.
      await inFlight.catch(() => undefined);
      stream.off("error", onSourceError);
      stream.off("close", onSourceClose);
    }
  })();
  void done.catch(() => undefined);
  // Node resumes child pipes on exit, so own writes before the caller subscribes.
  stream.pipe(sink);
  if (stream.errored) {
    sink.destroy(stream.errored);
  } else if (stream.destroyed) {
    onSourceClose();
  }
  const consume = (listener: Consumer): Promise<void> => {
    if (closed || subscribed) {
      return Promise.reject(new Error("Process stdout consumption is already owned or closed"));
    }
    subscribed = true;
    subscription.resolve(listener);
    return done;
  };
  return {
    consume,
    drain: () => (subscribed || closed ? done : consume(() => {})),
    close: () => {
      closed = true;
      subscription.resolve(undefined);
      if (!sink.writableFinished) {
        stream.unpipe(sink);
        sink.destroy(new Error("Process stdout consumption closed"));
      }
    },
  };
}

/** Output failure requests stop separately; both completion paths settle before returning. */
export async function joinProcessCompletionAndOutput<T>(
  completion: Promise<T>,
  output: Promise<void>,
): Promise<T> {
  const [outcome, consumed] = await Promise.allSettled([completion, output]);
  if (outcome.status === "rejected") {
    if (consumed.status === "rejected") {
      throw new AggregateError(
        [outcome.reason, consumed.reason],
        "Process and stdout consumption failed",
      );
    }
    throw outcome.reason;
  }
  if (consumed.status === "rejected") {
    throw consumed.reason;
  }
  return outcome.value;
}
