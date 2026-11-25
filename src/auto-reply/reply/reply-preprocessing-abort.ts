import { createAbortError } from "../../infra/abort-signal.js";

export function assertReplyPreprocessingActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError("Reply canceled during preprocessing", { cause: signal.reason });
  }
}
