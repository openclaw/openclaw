import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import type {
  TranscriptPageReadOperation,
  TranscriptPageReadOperationInput,
  TranscriptPageReadResult,
  TranscriptReadAccounting,
} from "./session-transcript-page-read.types.js";
import {
  acquireHistoryDatabaseResource,
  type HistoryDatabaseResource,
  type SessionHistoryDatabaseTarget,
} from "./session-transcript-worker-resources.js";
import { retainSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

const MAX_TRANSCRIPT_PAGE_READ_WINDOW_MS = 5_000;
const pageReadOperationTails = new WeakMap<HistoryDatabaseResource, Promise<unknown>>();

/**
 * One admitted transcript-page operation per physical store: queue, native
 * execution and settlement share the caller's single deadline, and custody is
 * held until every phase settles. A cleanup failure rejects `settled` and
 * keeps the resource's admission closed for its retry owner.
 */
export function startTranscriptPageRead(
  target: SessionHistoryDatabaseTarget,
  input: TranscriptPageReadOperationInput,
): TranscriptPageReadOperation {
  if (input.deadlineAt - performance.now() > MAX_TRANSCRIPT_PAGE_READ_WINDOW_MS) {
    throw new RangeError(
      `Transcript page read deadline exceeds the ${MAX_TRANSCRIPT_PAGE_READ_WINDOW_MS} ms operation budget`,
    );
  }
  const resource = acquireHistoryDatabaseResource(target);
  const previous = pageReadOperationTails.get(resource);
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([controller.signal, input.signal])
    : controller.signal;
  const emptyAccounting: TranscriptReadAccounting = {
    scannedEntries: 0,
    materializedBytes: 0,
    exhausted: false,
    final: false,
  };
  let cleanup: Promise<void> = Promise.resolve();
  const response = (async (): Promise<TranscriptPageReadResult> => {
    await previous;
    const remaining = input.deadlineAt - performance.now();
    if (remaining <= 0) {
      return { ok: false, error: "timed_out", budget: { ...emptyAccounting } };
    }
    const retained = retainSessionHistoryWorkerDatabase(target);
    cleanup = (async () => {
      retained.release();
    })();
    return retained.owner.readTranscriptPage(
      { request: input.request, expectedIdentity: input.expectedIdentity },
      signal,
      remaining,
    );
  })();
  const settled = (async (): Promise<TranscriptReadAccounting> => {
    const result = await response;
    await cleanup;
    return result.budget;
  })();
  pageReadOperationTails.set(
    resource,
    settled.then(
      () => undefined,
      () => undefined,
    ),
  );
  return {
    response,
    settled,
    cancel: () => {
      controller.abort(new WorkerTaskError("Transcript page read was canceled", "unavailable"));
    },
  };
}
