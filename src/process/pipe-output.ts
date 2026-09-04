import type { Readable, Writable } from "node:stream";

/** Keep native backpressure while leaving the caller's diagnostic destination open. */
export function pipeProcessOutput(
  source: Readable,
  destination: Writable,
  reportError: (error: Error) => void,
): () => void {
  const cleanup = () => {
    source.unpipe(destination);
    source.off("close", cleanup);
    destination.off("close", cleanup);
    destination.off("error", onError);
  };
  const onError = (error: Error) => {
    cleanup();
    reportError(error);
  };
  source.once("close", cleanup);
  destination.once("close", cleanup);
  destination.on("error", onError);
  source.pipe(destination, { end: false });
  return cleanup;
}
