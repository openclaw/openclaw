import { randomUUID } from "node:crypto";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import type {
  NodeWorkerProcessInput,
  WorkerProcessObservationResult,
} from "../worker/worker-process-observation.js";
import { sendNodeWorkerInput } from "./node-worker-launch-transport.js";
import {
  nodeWorkerEnvironmentMatches,
  type NodeWorkerRunningChild,
} from "./node-worker-supervisor-ownership.js";

/** Correlated operations belong to the physical child, not to its latest model turn. */
export class NodeWorkerProcessObservations {
  private readonly pending = new Map<
    string,
    { owner: NodeWorkerRunningChild; result: Deferred<WorkerProcessObservationResult> }
  >();

  retire(owner: NodeWorkerRunningChild): void {
    for (const pending of this.pending.values()) {
      if (pending.owner === owner) {
        pending.result.reject(new Error("Worker process owner ended; refresh the process list."));
      }
    }
  }

  accept(owner: NodeWorkerRunningChild, frame: WorkerProcessObservationResult): void {
    const pending = this.pending.get(frame.requestId);
    if (pending?.owner === owner) {
      pending.result.resolve(frame);
    }
  }

  async request(
    owner: NodeWorkerRunningChild,
    input: NodeWorkerProcessInput,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ) {
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (
        !isCurrent() ||
        owner.retiring ||
        owner.stopState ||
        !nodeWorkerEnvironmentMatches(owner.binding, input) ||
        owner.binding.placementGeneration !== input.placementGeneration ||
        owner.binding.bundleHash !== input.expectedBundleHash
      ) {
        throw new Error("Worker process owner changed; refresh the process list.");
      }
    };
    const timeout = AbortSignal.timeout(10_000);
    const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;
    assertCurrent();
    await racePromiseWithAbortSignal(owner.journalReady, lifetime);
    assertCurrent();
    if (this.pending.size >= 64) {
      throw new Error("Worker process observation is busy; retry shortly.");
    }
    const requestId = randomUUID();
    const result = createDeferredCore<WorkerProcessObservationResult>();
    this.pending.set(requestId, { owner, result });
    void result.promise.catch(() => undefined);
    try {
      assertCurrent();
      void sendNodeWorkerInput(owner.adapter, {
        type: "process",
        requestId,
        environmentId: input.environmentId,
        sessionId: input.sessionId,
        ownerEpoch: input.ownerEpoch,
        operation: input.operation,
      }).catch((error: unknown) => result.reject(error));
      const response = await racePromiseWithAbortSignal(result.promise, lifetime);
      assertCurrent();
      if (!response.result) {
        throw new Error(response.error ?? "Worker process observation unavailable.");
      }
      return response.result;
    } finally {
      this.pending.delete(requestId);
    }
  }
}
