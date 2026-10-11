import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildRestartRecoveryClaimCleanupPatch } from "./restart-recovery-state.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { projectCompactionAccountingPatch } from "./session-entry-projection.js";
import type { buildSessionCreationStamp } from "./session-entry-provenance.js";
import {
  projectSessionEntryUsageUpdate,
  type SessionEntryUsageUpdate,
} from "./session-entry-usage.js";
import {
  projectPendingFinalDeliverySettlement,
  type PendingFinalDeliverySettlementInput,
} from "./session-pending-final-settlement.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import { sessionMatchesExpectedTranscriptTurn } from "./session-transcript-turn-state.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type InternalSessionEntry as SessionEntry,
} from "./types.js";

type ExpectedSession = Pick<SessionEntry, "sessionId"> &
  Partial<Pick<SessionEntry, "lifecycleRevision" | "activeWriterRunId">>;

/** Closed internal operations; arbitrary updater callbacks retain prepare/CAS. */
export type SessionEntryPatchOperation = (
  | { kind: "fields"; patch: Partial<SessionEntry> }
  | {
      kind: "ensure-identity";
      sessionId: string;
      creation: ReturnType<typeof buildSessionCreationStamp>;
    }
  | { kind: "usage-accounting"; usage: SessionEntryUsageUpdate }
  | { kind: "pending-final-settle"; settlement: PendingFinalDeliverySettlementInput }
  | {
      kind: "restart-admission";
      sessionId: string;
      expectedSessionState: SessionTranscriptTurnExpectedState;
      patch: SessionTranscriptTurnLifecyclePatch;
    }
  | {
      kind: "pending-final-clear";
      sessionId: string;
      intentId: string;
      recoveryRunId?: string;
      now: number;
    }
  | {
      kind: "restart-safe-terminal";
      runId: string;
      retryable: boolean;
      patch: Partial<SessionEntry>;
    }
  | {
      kind: "restart-claim-clear";
      sessionId: string;
      recoveryRunId: string;
      recoverySourceRunId?: string;
      executionRunId: string;
      executionGeneration: string;
    }
  | {
      kind: "compaction-accounting";
      accounting: Parameters<typeof projectCompactionAccountingPatch>[1];
    }
) & { expected?: ExpectedSession };

export function reduceSessionEntryPatch(
  operation: SessionEntryPatchOperation,
  entry: SessionEntry,
  existingEntry: SessionEntry | undefined,
): Partial<SessionEntry> | null {
  const expected = operation.expected;
  if (
    expected &&
    (entry.sessionId !== expected.sessionId ||
      (Object.hasOwn(expected, "lifecycleRevision") &&
        entry.lifecycleRevision !== expected.lifecycleRevision) ||
      (Object.hasOwn(expected, "activeWriterRunId") &&
        entry.activeWriterRunId !== expected.activeWriterRunId))
  ) {
    return null;
  }
  switch (operation.kind) {
    case "ensure-identity":
      return existingEntry?.sessionId
        ? null
        : existingEntry
          ? { sessionId: operation.sessionId }
          : { ...operation.creation, sessionId: operation.sessionId };
    case "fields":
      return operation.patch;
    case "compaction-accounting":
      return projectCompactionAccountingPatch(entry, operation.accounting);
    case "usage-accounting":
      return projectSessionEntryUsageUpdate(entry, operation.usage);
    case "pending-final-settle":
      return projectPendingFinalDeliverySettlement(entry, operation.settlement).patch;
    case "restart-admission":
      return sessionMatchesExpectedTranscriptTurn(
        { entry },
        {
          expectedSessionId: operation.sessionId,
          expectedSessionState: operation.expectedSessionState,
        },
      )
        ? operation.patch
        : null;
    case "pending-final-clear": {
      const recoveryRunId = normalizeOptionalString(entry.restartRecoveryDeliveryRunId);
      const deliveries = entry.pendingFinalDelivery?.deliveries;
      if (
        entry.sessionId !== operation.sessionId ||
        entry.pendingFinalDelivery?.intentId !== operation.intentId ||
        !deliveries?.length ||
        !deliveries.every(({ state }) => state === "delivered" || state === "suppressed") ||
        (recoveryRunId !== undefined && recoveryRunId !== operation.recoveryRunId)
      ) {
        return null;
      }
      const completesHookTurn =
        recoveryRunId === undefined &&
        (entry.restartRecoveryBeforeAgentReplyState === "handled-reply" ||
          entry.restartRecoveryBeforeAgentReplyState === "handled-unrecoverable");
      return {
        ...(recoveryRunId
          ? buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: true })
          : {
              restartRecoveryBeforeAgentReplyState: undefined,
              restartRecoverySourceIngress: undefined,
              restartRecoveryOperatorSource: undefined,
              restartRecoveryForceSafeTools: undefined,
            }),
        pendingFinalDelivery: undefined,
        ...(completesHookTurn
          ? {
              abortedLastRun: false,
              endedAt: operation.now,
              lifecycleRunId: undefined,
              runtimeMs:
                typeof entry.startedAt === "number"
                  ? Math.max(0, operation.now - entry.startedAt)
                  : undefined,
              status: "done" as const,
            }
          : {}),
      };
    }
    case "restart-safe-terminal":
      return entry.restartRecoveryDeliveryRunId === operation.runId
        ? {
            ...operation.patch,
            ...(!operation.retryable
              ? buildRestartRecoveryClaimCleanupPatch({
                  entry,
                  recordTerminalSource: true,
                  terminalSourceRunId: entry.restartRecoveryDeliverySourceRunId,
                })
              : {}),
          }
        : null;
    case "restart-claim-clear": {
      const isExecutionFence = (run: NonNullable<SessionEntry["restartRecoveryRuns"]>[number]) =>
        run.runId === operation.executionRunId &&
        run.lifecycleGeneration === operation.executionGeneration;
      const ownsClaim =
        entry.restartRecoveryDeliveryRunId !== undefined
          ? entry.restartRecoveryDeliveryRunId === operation.recoveryRunId &&
            normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ===
              operation.recoverySourceRunId
          : entry.restartRecoveryRuns?.some(isExecutionFence) === true;
      if (
        entry.sessionId !== operation.sessionId ||
        (entry.abortedLastRun === true && entry.mainRestartRecovery !== undefined) ||
        !ownsClaim
      ) {
        return null;
      }
      // Unknown provider outcomes retire their source without replay. Until this
      // commit, the active receipt still belongs to restart-safe reconciliation.
      const terminalPending = entry.restartRecoveryDeliveryReceiptState === "terminal-pending";
      const preservesPendingFinal = !terminalPending && entry.pendingFinalDelivery !== undefined;
      const completesHandledSilent =
        entry.restartRecoveryBeforeAgentReplyState === "handled-silent" && !preservesPendingFinal;
      const endedAt = terminalPending || completesHandledSilent ? Date.now() : undefined;
      const remainingRuns = entry.restartRecoveryRuns?.filter((run) => !isExecutionFence(run));
      return {
        ...buildRestartRecoveryClaimCleanupPatch({
          entry,
          recordTerminalSource: true,
          terminalSourceRunId: operation.recoverySourceRunId,
          terminalRunId: entry.restartRecoveryDeliveryRunId ? undefined : operation.executionRunId,
        }),
        restartRecoveryRuns: remainingRuns?.length ? remainingRuns : undefined,
        ...(terminalPending ? { pendingFinalDelivery: undefined } : {}),
        // Transport settlement owns the pending intent and its hook-safety provenance.
        ...(preservesPendingFinal
          ? {
              restartRecoveryBeforeAgentReplyState: entry.restartRecoveryBeforeAgentReplyState,
              restartRecoverySourceIngress: entry.restartRecoverySourceIngress,
              restartRecoveryForceSafeTools: entry.restartRecoveryForceSafeTools,
            }
          : {}),
        ...(endedAt !== undefined
          ? {
              abortedLastRun: terminalPending,
              endedAt,
              lifecycleRunId: undefined,
              runtimeMs:
                typeof entry.startedAt === "number"
                  ? Math.max(0, endedAt - entry.startedAt)
                  : undefined,
              status: terminalPending ? ("failed" as const) : ("done" as const),
            }
          : {}),
        updatedAt: endedAt ?? Date.now(),
      };
    }
  }
  return operation satisfies never;
}

export function mergeSessionEntryPatch(params: {
  existing: SessionEntry | undefined;
  writeBase: SessionEntry;
  patch: Partial<SessionEntry> | null;
  sessionKey: string;
  replaceEntry?: boolean;
  preserveActivity?: boolean;
}): SessionEntry | undefined {
  const { existing, writeBase, patch, sessionKey } = params;
  // A fallback supplies identity, not an existing node's immutable creation policy.
  const creationPatch = !existing && patch ? { ...writeBase, ...patch } : patch;
  if (!creationPatch) {
    return undefined;
  }
  if (params.replaceEntry) {
    // SAFETY: The existing replaceEntry updater contract supplies a complete entry.
    return structuredClone(patch as SessionEntry);
  }
  const merged = params.preserveActivity
    ? mergeSessionEntryPreserveActivity(existing, creationPatch)
    : mergeSessionEntry(existing, creationPatch);
  return preserveSqliteSameKeySessionRolloverLineage({
    next: merged,
    previous: writeBase,
    sessionKey,
  });
}
