export function raceNodeWorkerOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  messages: { aborted: string; failed?: string } = {
    aborted: "node worker operation aborted",
    failed: "node worker operation failed",
  },
): Promise<T> {
  if (!signal) {
    return operation;
  }
  const abortError = () =>
    signal.reason instanceof Error ? signal.reason : new Error(messages.aborted);
  return racePromiseWithAbortSignal(operation, signal, abortError).catch((error: unknown) => {
    throw error instanceof Error ? error : new Error(messages.failed ?? String(error));
  });
}
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
