import type { OperationalRunInstanceRef } from "../agents/operational-run-instance.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { SessionControllerInput } from "./session-controller.contracts.js";
import { trackSessionControllerSourceWork } from "./session-controller.mailbox-source.js";
import { sessionTargetOwnersMatch, type SessionTarget } from "./session-controller.target.js";

export type SessionControllerProducerCancellationGuard = {
  revalidate(): Promise<void>;
  assertCurrent(): void;
};

export type SessionControllerProducer = Readonly<{
  target: SessionTarget;
  runInstance: OperationalRunInstanceRef;
  signal: AbortSignal;
  settled: Promise<void>;
  cancel(reason?: unknown, guard?: SessionControllerProducerCancellationGuard): void;
  revalidateCancellation(): Promise<void>;
  assertCancellationAllowed(): void;
  recordCancellationFailure(error: unknown): void;
  retainCleanupForSources(inputs: readonly SessionControllerInput[]): void;
  release(): void;
}>;

const producersByOwner = new WeakMap<object, Set<SessionControllerProducer>>();

/** Individual producer custody can borrow a turn without taking its parent's cancellation. */
export function registerSessionControllerProducer(params: {
  owner: object;
  target: SessionTarget;
  runInstance: OperationalRunInstanceRef;
}): SessionControllerProducer {
  const producers = producersByOwner.get(params.owner) ?? new Set<SessionControllerProducer>();
  producersByOwner.set(params.owner, producers);
  const controller = new AbortController();
  const completion = createDeferredCore();
  // The ingress promise reports failures even when nobody requests cancellation.
  void completion.promise.catch(() => {});
  let released = false;
  let cancellationFailure: unknown;
  let cancellationGuard: SessionControllerProducerCancellationGuard | undefined;
  const producer: SessionControllerProducer = {
    target: params.target,
    runInstance: params.runInstance,
    signal: controller.signal,
    settled: completion.promise,
    cancel(reason, guard) {
      if (released) {
        return;
      }
      guard?.assertCurrent();
      if (!controller.signal.aborted) {
        // Later callers join the first cancellation, including any RPC already in flight.
        cancellationGuard = guard;
        controller.abort(reason);
      }
    },
    async revalidateCancellation() {
      await cancellationGuard?.revalidate();
    },
    assertCancellationAllowed() {
      cancellationGuard?.assertCurrent();
    },
    recordCancellationFailure(error) {
      cancellationFailure ??= error;
    },
    retainCleanupForSources(inputs) {
      // Cancellation cleanup belongs to these exact sources, not the run's outcome.
      for (const input of inputs) {
        trackSessionControllerSourceWork(input, completion.promise);
      }
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      producers.delete(producer);
      if (!producers.size) {
        producersByOwner.delete(params.owner);
      }
      if (cancellationFailure === undefined) {
        completion.resolve();
      } else {
        completion.reject(cancellationFailure);
      }
    },
  };
  producers.add(producer);
  return producer;
}

/** Capture before awaiting authority; later arrivals cannot enter this selection. */
export function captureSessionControllerProducers(params: {
  owner: object;
  target?: SessionTarget;
  expectedRunId?: string;
  expectedInstanceId?: string;
}): readonly SessionControllerProducer[] {
  return [...(producersByOwner.get(params.owner) ?? [])].filter(
    (producer) =>
      (!params.target ||
        (sessionTargetOwnersMatch(producer.target, params.target) &&
          producer.target.sessionKey === params.target.sessionKey)) &&
      (!params.expectedRunId || producer.runInstance.runId === params.expectedRunId) &&
      (!params.expectedInstanceId || producer.runInstance.instanceId === params.expectedInstanceId),
  );
}
