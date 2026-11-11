/** Per-admission preparation and durable enqueue; the monitor retains scheduling and drain custody. */
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { createChannelIngressDrainOwner } from "./ingress-drain.js";
import { appendIngressWithRetry } from "./ingress-monitor-tasks.js";
import type {
  ChannelIngressMonitorAdmissionResult,
  ChannelIngressMonitorFacts,
  CreateChannelIngressMonitorOptions,
} from "./ingress-monitor-types.js";
import type { ChannelIngressQueue } from "./ingress-queue.js";

export type ChannelIngressAdmissionContext = {
  receivedAt: number;
  facts?: ChannelIngressMonitorFacts;
  onDurablyAdmitted: (alreadyClaimed?: boolean) => void;
};

type AdmissionDrain<TStoredPayload, TMetadata> = ReturnType<
  typeof createChannelIngressDrainOwner<TStoredPayload, TMetadata>
>;

type ChannelIngressAdmissionOptions<TRaw, TBody, TStoredPayload, TMetadata> = Pick<
  CreateChannelIngressMonitorOptions<TRaw, TBody, TStoredPayload, TMetadata>,
  | "payload"
  | "appendRetryDelaysMs"
  | "onDurableAdmission"
  | "onAdmissionFailure"
  | "reuseAdmissionFactsForFreshClaims"
  | "prepareAdmission"
> & {
  signal: AbortSignal;
  inspect: (
    raw: TRaw,
  ) => ChannelIngressMonitorFacts | null | Promise<ChannelIngressMonitorFacts | null>;
  getQueue: () => ChannelIngressQueue<TStoredPayload, TMetadata>;
  pruneBeforeAdmission: () => Promise<void>;
  getIdleDrain: () => AdmissionDrain<TStoredPayload, TMetadata> | undefined;
  recoverUntrackedClaim: (drain: AdmissionDrain<TStoredPayload, TMetadata>) => void;
  scheduleDrainIdleWake: (drain: AdmissionDrain<TStoredPayload, TMetadata>) => void;
};

export function createChannelIngressAdmission<TRaw, TBody, TStoredPayload, TMetadata>(
  options: ChannelIngressAdmissionOptions<TRaw, TBody, TStoredPayload, TMetadata>,
) {
  type Queue = ChannelIngressQueue<TStoredPayload, TMetadata>;
  return async (rawEvents: readonly TRaw[], admitOptions: ChannelIngressAdmissionContext) => {
    const prepared: Array<{
      raw: TRaw;
      facts: ChannelIngressMonitorFacts;
      payload: TStoredPayload;
      index: number;
      assertCurrent?: () => void;
    }> = [];
    const results: ChannelIngressMonitorAdmissionResult<Awaited<ReturnType<Queue["enqueue"]>>>[] =
      [];
    const { receivedAt } = admitOptions;
    for (const raw of rawEvents) {
      try {
        const facts = admitOptions.facts ?? (await options.inspect(raw));
        if (!facts) {
          results.push({ kind: "ignored" });
          continue;
        }
        const transformed = await options.prepareAdmission?.(raw, {
          facts,
          receivedAt,
          signal: options.signal,
        });
        const preparedRaw = transformed ? transformed.raw : raw;
        if (transformed) {
          const currentFacts = await options.inspect(preparedRaw);
          transformed.assertCurrent();
          if (
            !currentFacts ||
            currentFacts.eventId !== facts.eventId ||
            currentFacts.laneKey !== facts.laneKey
          ) {
            throw new Error("Channel ingress transform changed event identity or lane");
          }
        }
        const body = options.payload.serialize(preparedRaw, { facts, receivedAt });
        const payload =
          options.payload.storage === "raw-event"
            ? ({ version: options.payload.version, rawEvent: body } as TStoredPayload) // SAFETY: raw-event codecs use this envelope.
            : options.payload.encode({ version: options.payload.version, body });
        prepared.push({
          raw: preparedRaw,
          facts,
          payload,
          index: results.length,
          assertCurrent: transformed?.assertCurrent,
        });
        results.push({ kind: "ignored" });
      } catch (error) {
        await options.onAdmissionFailure?.(raw, error);
        throw error;
      }
    }
    if (prepared.length === 0) {
      return results;
    }
    let admissionQueue: Queue;
    let queueResults: Array<Awaited<ReturnType<Queue["enqueue"]>>> | undefined;
    let releaseDispatch: (() => void) | undefined;
    const hasPolicy = prepared.some((entry) => entry.assertCurrent !== undefined);
    const assertCurrent = () => prepared.forEach((entry) => entry.assertCurrent?.());
    try {
      admissionQueue = options.getQueue();
      await options.pruneBeforeAdmission();
      assertCurrent();
      const enqueueBatch = admissionQueue.enqueueBatch?.bind(admissionQueue);
      const enqueueAndClaim = admissionQueue.enqueueAndClaim?.bind(admissionQueue);
      const idleDrain =
        !hasPolicy && prepared.length === 1 && enqueueAndClaim ? options.getIdleDrain() : undefined;
      const ownerId = idleDrain?.idleOwnerId();
      if (idleDrain && ownerId && enqueueAndClaim) {
        const { facts, payload } = prepared[0]!;
        let admitted: Awaited<ReturnType<typeof enqueueAndClaim>>;
        try {
          admitted = await appendIngressWithRetry(
            () =>
              enqueueAndClaim(facts.eventId, payload, {
                ownerId,
                receivedAt,
                laneKey: facts.laneKey,
              }),
            options.appendRetryDelaysMs,
          );
        } catch (error) {
          if (hasSqliteWorkerOutcomeUnknown(error)) {
            // The committed claim may not have reached us. Retire this empty
            // owner so the ordinary recovery pass can take it without a lease wait.
            options.recoverUntrackedClaim(idleDrain);
          }
          throw error;
        }
        queueResults = [admitted.result];
        if (admitted.freshClaim) {
          const ackSettled = createDeferredCore();
          try {
            idleDrain.dispatchClaimed(
              admitted.freshClaim,
              ackSettled.promise,
              options.reuseAdmissionFactsForFreshClaims ? facts.laneKey : undefined,
            );
          } catch (error) {
            // Lane policy can throw before tracking. The unresolved ACK barrier
            // prevents dispatch, so retire the owner and recover this durable row.
            options.recoverUntrackedClaim(idleDrain);
            ackSettled.resolve();
            throw error;
          }
          releaseDispatch = () => {
            ackSettled.resolve();
            options.scheduleDrainIdleWake(idleDrain);
          };
        }
      } else if (hasPolicy && prepared.length > 1) {
        const enqueueAuthorized = admissionQueue.enqueueBatchAuthorized?.bind(admissionQueue);
        if (!enqueueAuthorized) {
          throw new Error("Channel ingress policy requires an authorized batch queue");
        }
        queueResults = await appendIngressWithRetry(
          () =>
            enqueueAuthorized(
              prepared.map(({ facts, payload }) => ({
                id: facts.eventId,
                payload,
                receivedAt,
                laneKey: facts.laneKey,
              })),
              { assertCurrent },
            ),
          options.appendRetryDelaysMs,
        );
      } else if (prepared.length > 1 && enqueueBatch) {
        queueResults = await appendIngressWithRetry(
          () =>
            enqueueBatch(
              prepared.map(({ facts, payload }) => ({
                id: facts.eventId,
                payload,
                receivedAt,
                laneKey: facts.laneKey,
              })),
            ),
          options.appendRetryDelaysMs,
        );
      }
    } catch (error) {
      for (const { raw } of prepared) {
        await options.onAdmissionFailure?.(raw, error);
      }
      throw error;
    }
    for (const [index, { raw, facts, payload, index: resultIndex }] of prepared.entries()) {
      try {
        // Shipped plugin-supplied queues may implement only individual admission.
        const enqueue = () => {
          if (hasPolicy) {
            if (!admissionQueue.enqueueAuthorized) {
              throw new Error("Channel ingress policy requires an authorized queue");
            }
            return admissionQueue.enqueueAuthorized(facts.eventId, payload, {
              receivedAt,
              laneKey: facts.laneKey,
              assertCurrent,
            });
          }
          return admissionQueue.enqueue(facts.eventId, payload, {
            receivedAt,
            laneKey: facts.laneKey,
          });
        };
        const queueResult = queueResults
          ? queueResults[index]!
          : await appendIngressWithRetry(enqueue, options.appendRetryDelaysMs);
        admitOptions.onDurablyAdmitted(Boolean(releaseDispatch));
        results[resultIndex] = { kind: "durable", queueResult };
        await options.onDurableAdmission?.(raw, {
          facts,
          receivedAt,
          isNew: queueResult.kind === "accepted",
        });
      } catch (error) {
        await options.onAdmissionFailure?.(raw, error);
        throw error;
      } finally {
        releaseDispatch?.();
      }
    }
    return results;
  };
}
