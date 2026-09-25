import type { OpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { replyRunRegistry, type ReplyOperation } from "./reply-run-registry.js";
import {
  isReplyOperationAbortedForRestart,
  lifecycleAdmissionByOperation,
  mergeReplyRunAdmissionSource,
  observeReplyRunCompletions,
  type ReplyRunAdmissionSource,
} from "./reply-run-registry.state.js";

type ReplyRotationSource = ReplyRunAdmissionSource & { fromBarrier: boolean };

/** Retains invocation-local lineage evidence; the admission owner decides whether work may start. */
export function createReplyTurnRotationEvidence(params: {
  sessionKey: string;
  /** Observed predecessors, from oldest to newest. */
  expectedActiveOperations?: readonly ReplyOperation[];
  activeAtAdmission?: ReplyOperation;
}) {
  const waitedRotations = new Map<ReplyRotationSource["databaseIdentity"], ReplyRotationSource>();
  const observedOperations = new Map<ReplyOperation, OpenClawAgentDatabaseIdentity | undefined>();
  // Barrier snapshots retain their source lane after rekeying; active owners do not.
  const isCurrent = (source: ReplyRotationSource) =>
    !isReplyOperationAbortedForRestart(source.operation) &&
    (source.fromBarrier ||
      (lifecycleAdmissionByOperation.get(source.operation)?.databaseIdentity ===
        source.databaseIdentity &&
        source.operation.key === params.sessionKey &&
        (source.operation === replyRunRegistry.get(params.sessionKey) ||
          source.operation.result !== null)));
  const mergeWaitedRotation = (source: ReplyRotationSource) => {
    const previous = waitedRotations.get(source.databaseIdentity);
    // Candidate joins must not mutate history or acquire IDs from later rekeys.
    return mergeReplyRunAdmissionSource(
      source,
      previous && isCurrent(previous)
        ? { ...previous, sessionIds: new Set(previous.sessionIds) }
        : undefined,
    );
  };

  const recordSources = (sources: readonly ReplyRunAdmissionSource[], fromBarrier: boolean) => {
    for (const source of sources) {
      waitedRotations.set(
        source.databaseIdentity,
        mergeWaitedRotation({ ...source, sessionIds: new Set(source.sessionIds), fromBarrier }),
      );
    }
  };

  return {
    capturePreparation() {
      const registered = replyRunRegistry.get(params.sessionKey);
      // A newly observed predecessor may complete before preparation retries.
      // Retain its original store, not an association acquired by later adoption.
      if (registered && !observedOperations.has(registered)) {
        observedOperations.set(
          registered,
          lifecycleAdmissionByOperation.get(registered)?.databaseIdentity,
        );
      }
      const observations = [
        ...new Set([
          ...(params.expectedActiveOperations ?? []),
          params.activeAtAdmission,
          ...observedOperations.keys(),
          registered,
          ...Array.from(waitedRotations.values(), (source) => source.operation),
        ]),
      ].flatMap((operation) =>
        operation
          ? [
              {
                operation,
                key: operation.key,
                sessionId: operation.sessionId,
                result: operation.result,
                databaseIdentity: lifecycleAdmissionByOperation.get(operation)?.databaseIdentity,
              },
            ]
          : [],
      );
      // These values invalidate a delayed row, never authorize a new logical ID.
      // In particular, observing a rekey must not extend immutable barrier history.
      return () =>
        replyRunRegistry.get(params.sessionKey) === registered &&
        observations.every(
          ({ operation, key, sessionId, result, databaseIdentity }) =>
            operation.key === key &&
            operation.sessionId === sessionId &&
            operation.result === result &&
            lifecycleAdmissionByOperation.get(operation)?.databaseIdentity === databaseIdentity,
        );
    },
    recordBarrierSources(sources: ReplyRunAdmissionSource[] = []) {
      recordSources(sources, true);
    },
    observeAdmission() {
      const completions = observeReplyRunCompletions(params.sessionKey);
      const initialOperation = replyRunRegistry.get(params.sessionKey);
      return {
        recordCompletions: () => recordSources(completions.read() ?? [], false),
        changed: () =>
          completions.read() !== undefined ||
          initialOperation !== replyRunRegistry.get(params.sessionKey),
        dispose: () => {
          const sources = completions.read();
          completions.dispose();
          recordSources(sources ?? [], false);
        },
      };
    },
    recordCompletedOperation(
      operation: ReplyOperation,
      databaseIdentity: OpenClawAgentDatabaseIdentity | undefined,
    ) {
      if (lifecycleAdmissionByOperation.get(operation)?.databaseIdentity !== databaseIdentity) {
        return;
      }
      waitedRotations.set(
        databaseIdentity,
        mergeWaitedRotation({
          operation,
          sessionId: operation.sessionId,
          sessionIds: operation.captureOwnedSessionIds(),
          databaseIdentity,
          fromBarrier: false,
        }),
      );
    },
    takeStorelessRotation(): { sessionId: string; sessionIds: ReadonlySet<string> } | undefined {
      const source = waitedRotations.get(undefined);
      waitedRotations.delete(undefined);
      return source && isCurrent(source) ? source : undefined;
    },
    hasExpectedSessionRotation(target: {
      expectedSessionId: string | undefined;
      sessionId: string | undefined;
      databaseIdentity: OpenClawAgentDatabaseIdentity | undefined;
    }): boolean {
      const registeredOperation = replyRunRegistry.get(params.sessionKey);
      const rotationSources = [...waitedRotations.values()];
      for (const candidate of new Set([
        ...(params.expectedActiveOperations ?? []),
        params.activeAtAdmission,
        ...observedOperations.keys(),
        registeredOperation,
      ])) {
        if (candidate) {
          const currentDatabaseIdentity =
            lifecycleAdmissionByOperation.get(candidate)?.databaseIdentity;
          const databaseIdentity = observedOperations.has(candidate)
            ? observedOperations.get(candidate)
            : currentDatabaseIdentity;
          if (databaseIdentity !== currentDatabaseIdentity) {
            continue;
          }
          let source = mergeWaitedRotation({
            operation: candidate,
            sessionId: candidate.sessionId,
            sessionIds: candidate.captureOwnedSessionIds(),
            databaseIdentity,
            fromBarrier: false,
          });
          if (!isCurrent(source)) {
            continue;
          }
          for (const previous of rotationSources) {
            if (isCurrent(previous)) {
              source = mergeReplyRunAdmissionSource(source, {
                ...previous,
                sessionIds: new Set(previous.sessionIds),
              });
            }
          }
          rotationSources.push(source);
        }
      }
      return rotationSources.some(
        (source) =>
          target.expectedSessionId &&
          target.databaseIdentity !== undefined &&
          source.databaseIdentity === target.databaseIdentity &&
          target.sessionId === source.sessionId &&
          isCurrent(source) &&
          source.sessionIds.has(target.expectedSessionId),
      );
    },
  };
}
