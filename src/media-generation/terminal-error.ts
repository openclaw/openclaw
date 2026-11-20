import { recordModelFallbackStop } from "../agents/model-fallback-stop.js";

/** Stop automatic media fallback once submission or cleanup is no longer known to be unsent. */
export function createMediaGenerationTerminalError(reason: unknown): Error {
  const error =
    reason instanceof Error
      ? reason
      : new Error("Media generation cannot safely fall back after submission.", { cause: reason });
  recordModelFallbackStop(error);
  return error;
}
