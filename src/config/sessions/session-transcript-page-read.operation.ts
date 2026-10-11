import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { sessionHistoryCleanupError } from "./session-history-worker-errors.js";
import type {
  TranscriptPageReadOperation,
  TranscriptPageReadOperationInput,
  TranscriptPageReadResult,
  TranscriptReadAccounting,
} from "./session-transcript-page-read.types.js";
import {
  acquireHistoryDatabaseResource,
  type SessionDatabaseCleanup,
  type SessionHistoryDatabaseTarget,
} from "./session-transcript-worker-resources.js";
import { retainSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

const MAX_WINDOW_MS = 5_000;
type Admission = { tail: Promise<unknown>; pending: number; failure?: unknown };
// Store-level serialization survives resource revocation/replacement until the
// previous generation's work and cleanup are joined by the existing owner.
const admissions = new Map<string, Admission>();

export class TranscriptPageAccountingUnavailableError extends Error {
  constructor(readonly budget: TranscriptReadAccounting) {
    super("Transcript page source accounting could not be verified");
  }
}

/** Bound the response independently; settlement owns the task and its cleanup. */
export function startTranscriptPageRead(
  target: SessionHistoryDatabaseTarget,
  input: TranscriptPageReadOperationInput,
): TranscriptPageReadOperation {
  const deadlineAt = input.deadlineAt;
  const remaining = deadlineAt - performance.now();
  if (!Number.isFinite(deadlineAt) || remaining > MAX_WINDOW_MS) {
    throw new RangeError("Transcript page read deadline must be finite and within 5000 ms");
  }
  const captured = {
    request: {
      ...input.request,
      scope: {
        ...input.request.scope,
        env: captureSessionTranscriptStorageEnvironment(input.request.scope.env ?? process.env),
      },
      limits: { ...input.request.limits },
      position: input.request.position && { ...input.request.position },
    },
    expectedIdentity: { ...input.expectedIdentity },
  };
  const resource = acquireHistoryDatabaseResource(target);
  const retained = retainSessionHistoryWorkerDatabase(target);
  const key = JSON.stringify(resource.database);
  const admission: Admission = admissions.get(key) ?? { tail: Promise.resolve(), pending: 0 };
  admissions.set(key, admission);
  admission.pending++;
  const previous = admission.tail;
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([controller.signal, input.signal])
    : controller.signal;
  const response = createDeferredCore<TranscriptPageReadResult>();
  // Callers may observe settlement first without an unhandled response rejection.
  void response.promise.catch(() => undefined);
  // A no-dispatch operation has a verified empty receipt.
  let budget: TranscriptReadAccounting = {
    scannedEntries: 0,
    materializedBytes: 0,
    exhausted: false,
    final: true,
  };
  let responded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopResponseWatch = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", interrupted);
  };
  const publish = (result: TranscriptPageReadResult) => {
    if (!responded) {
      responded = true;
      stopResponseWatch();
      response.resolve(result);
    }
  };
  const interrupted = () =>
    publish({
      ok: false,
      error: resource.revoked ? "forbidden" : "timed_out",
      budget: { ...budget, final: false },
    });
  const abort = () =>
    controller.abort(new WorkerTaskError("Transcript page read was revoked", "unavailable"));
  resource.aborters.add(abort);
  if (remaining <= 0) {
    abort();
  } else {
    timer = setTimeout(abort, remaining);
  }
  signal.addEventListener("abort", interrupted, { once: true });
  if (signal.aborted) {
    interrupted();
  }

  let readStarted = false;
  const work = (async (): Promise<TranscriptPageReadResult> => {
    await previous;
    if (admission.failure !== undefined) {
      const error = new WorkerTaskError(
        "Transcript page read admission is closed after failed settlement",
        "unavailable",
      );
      error.cause = admission.failure;
      throw error;
    }
    if (signal.aborted || performance.now() >= deadlineAt) {
      interrupted();
      return { ok: false, error: resource.revoked ? "forbidden" : "timed_out", budget };
    }
    retained.owner.assertCurrent();
    // The reader maps ordinary failures to results; only cleanup loss throws.
    readStarted = true;
    const result = await retained.owner.readTranscriptPage(
      captured,
      signal,
      deadlineAt - performance.now(),
    );
    budget = result.budget;
    if (signal.aborted || performance.now() >= deadlineAt) {
      interrupted();
    } else {
      publish(result);
    }
    return result;
  })();
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    retained.release();
    released = true;
    resource.cleanups.delete(recovery);
    admission.pending--;
    if (admission.pending === 0 && admissions.get(key) === admission) {
      admissions.delete(key);
    }
  };
  // A failed operation keeps custody until the database owner has joined native
  // cleanup. Closing that owner may retry release, but never replays the read.
  const recovery: SessionDatabaseCleanup = {
    run: async () => {
      await Promise.allSettled([work]);
      release();
    },
  };
  const settled = (async (): Promise<TranscriptReadAccounting> => {
    try {
      const result = await work;
      if (!result.budget.final) {
        throw new TranscriptPageAccountingUnavailableError(result.budget);
      }
      release();
      return result.budget;
    } catch (error) {
      // A blocked successor never entered the reader. Its claim is independent
      // of the predecessor's failure, regardless of the error's class or code.
      if (!readStarted) {
        try {
          release();
        } catch (cleanupError) {
          admission.failure ??= cleanupError;
          resource.cleanups.add(recovery);
          throw sessionHistoryCleanupError(error, cleanupError, "database close");
        }
      } else {
        admission.failure ??= error;
        resource.cleanups.add(recovery);
      }
      throw error;
    } finally {
      stopResponseWatch();
      resource.aborters.delete(abort);
    }
  })();
  // Register before work resumes: database close joins this effect before it
  // walks cleanups, including recovery registered by a rejected settlement.
  resource.hostEffects.add(settled);
  void settled.then(
    () => resource.hostEffects.delete(settled),
    (error: unknown) => {
      resource.hostEffects.delete(settled);
      if (!responded) {
        responded = true;
        response.reject(error);
      }
    },
  );
  admission.tail = settled.then(
    () => undefined,
    () => undefined,
  );
  return {
    response: response.promise,
    settled,
    cancel: abort,
  };
}
