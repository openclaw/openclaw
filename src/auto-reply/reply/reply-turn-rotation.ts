import type { ReplyOperation } from "../../sessions/session-controller.js";
import {
  getSessionControllerEntry,
  getSessionControllerEntryForOperation,
  type SessionControllerEntry,
  isReplyOperationAbortedForRestart,
  lifecycleAdmissionByOperation,
  mergeReplyRunAdmissionSource,
  observeReplyRunCompletions,
  type ReplyRunAdmissionSource,
} from "../../sessions/session-controller.state.js";
import type { OpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";

type ReplyRotationSource = ReplyRunAdmissionSource & { fromBarrier: boolean };

/** Retains invocation-local lineage evidence; the admission owner decides whether work may start. */
export function createReplyTurnRotationEvidence(params: {
  sessionKey: string;
  controller?: SessionControllerEntry;
  /** Observed predecessors, from oldest to newest. */
  expectedActiveOperations?: readonly ReplyOperation[];
  activeAtAdmission?: ReplyOperation;
}) {
  const controller = params.controller ?? getSessionControllerEntry(params.sessionKey);
  const waitedRotations = new Map<ReplyRotationSource["databaseIdentity"], ReplyRotationSource>();
  // Barrier snapshots retain their source lane after rekeying; active owners do not.
  const isCurrent = (source: ReplyRotationSource) =>
    !isReplyOperationAbortedForRestart(source.operation) &&
    (source.fromBarrier ||
      (getSessionControllerEntryForOperation(source.operation) === controller &&
        lifecycleAdmissionByOperation.get(source.operation)?.databaseIdentity ===
          source.databaseIdentity &&
        source.operation.key === params.sessionKey &&
        (source.operation === controller.active || source.operation.result !== null)));
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
    recordBarrierSources(sources: ReplyRunAdmissionSource[] = []) {
      recordSources(sources, true);
    },
    observeAdmission() {
      const completions = observeReplyRunCompletions(controller.id);
      const initialOperation = controller.active;
      return {
        recordCompletions: () => recordSources(completions.read() ?? [], false),
        changed: () => completions.read() !== undefined || initialOperation !== controller.active,
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
    hasCurrentRotationEvidence(): boolean {
      return [...waitedRotations.values()].some(isCurrent);
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
      const registeredOperation = controller.active;
      const rotationSources = [...waitedRotations.values()];
      for (const candidate of new Set([
        ...(params.expectedActiveOperations ?? []),
        params.activeAtAdmission,
        registeredOperation,
      ])) {
        if (candidate) {
          let source = mergeWaitedRotation({
            operation: candidate,
            sessionId: candidate.sessionId,
            sessionIds: candidate.captureOwnedSessionIds(),
            databaseIdentity: lifecycleAdmissionByOperation.get(candidate)?.databaseIdentity,
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
