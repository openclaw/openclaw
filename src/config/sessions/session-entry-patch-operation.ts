import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  projectAmbientTranscriptWatermark,
  type AmbientTranscriptWatermarkUpdate,
} from "./ambient-transcript-watermark-projection.js";
import { buildRestartRecoveryClaimCleanupPatch } from "./restart-recovery-state.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { projectCompactionAccountingPatch } from "./session-entry-projection.js";
import type { buildSessionCreationStamp } from "./session-entry-provenance.js";
import { preserveGenerationPrivateFields } from "./session-entry-public-patch.js";
import {
  projectSessionEntryUsageUpdate,
  type SessionEntryUsageUpdate,
} from "./session-entry-usage.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type InternalSessionEntry as SessionEntry,
} from "./types.js";

type ExpectedSession = Pick<SessionEntry, "sessionId"> &
  Partial<Pick<SessionEntry, "lifecycleRevision" | "activeWriterRunId">>;

export type SessionEntryBookkeepingReducer =
  | { kind: "activity"; updatedAt: number }
  | { kind: "usage"; update: SessionEntryUsageUpdate; updatedAt: number }
  | { kind: "group-intro"; needsSystemIntro: boolean }
  | { kind: "fallback-notice"; notice: SessionEntry["fallbackNotice"] }
  | {
      kind: "live-model";
      expected: Partial<
        Pick<
          SessionEntry,
          | "modelProvider"
          | "model"
          | "agentHarnessId"
          | "providerOverride"
          | "modelOverride"
          | "agentRuntimeOverride"
          | "authProfileOverride"
          | "authProfileOverrideSource"
          | "liveModelSwitchPending"
        >
      >;
      next: Pick<SessionEntry, "modelProvider" | "model" | "agentHarnessId">;
      clearPending?: true;
    };

/** Closed internal operations; arbitrary updater callbacks retain prepare/CAS. */
type SessionEntryPatchStep = (
  | { kind: "fields"; patch: Partial<SessionEntry> }
  | { kind: "public-fields"; patch: Partial<SessionEntry> }
  | { kind: "ambient-transcript-watermark"; watermark: AmbientTranscriptWatermarkUpdate }
  | {
      kind: "ensure-identity";
      sessionId: string;
      creation: ReturnType<typeof buildSessionCreationStamp>;
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
) & { expected?: ExpectedSession | null };

export type SessionEntryPatchOperation =
  | SessionEntryPatchStep
  | { kind: "compound"; operations: readonly SessionEntryPatchStep[] };

/** Each reducer observes its predecessor's postimage; callers persist only the result. */
export function projectSessionEntryPatch(
  params: Omit<Parameters<typeof mergeSessionEntryPatch>[0], "patch"> & {
    operation: SessionEntryPatchOperation;
  },
): SessionEntry | undefined {
  const operations =
    params.operation.kind === "compound" ? params.operation.operations : [params.operation];
  let existing = params.existing;
  let writeBase = params.writeBase;
  let next: SessionEntry | undefined;
  for (const operation of operations) {
    const patch = reduceSessionEntryPatch(operation, writeBase, existing);
    if (patch === null) {
      continue;
    }
    next = mergeSessionEntryPatch({ ...params, existing, writeBase, patch });
    if (next) {
      existing = writeBase = next;
    }
  }
  return next;
}

/** Shared by the actor and its retained native/SDK patch adapter. */
export function reduceSessionBookkeeping(
  entry: SessionEntry,
  reducer: SessionEntryBookkeepingReducer,
): Partial<SessionEntry> | null {
  switch (reducer.kind) {
    case "activity":
      return entry.updatedAt === 0
        ? null
        : { updatedAt: Math.max(entry.updatedAt, reducer.updatedAt) };
    case "usage":
      return projectSessionEntryUsageUpdate(entry, reducer.update, reducer.updatedAt);
    case "group-intro":
      return { groupActivationNeedsSystemIntro: reducer.needsSystemIntro };
    case "fallback-notice":
      return { fallbackNotice: structuredClone(reducer.notice) };
    case "live-model":
      // SAFETY: This internal reducer's closed expected record contains only SessionEntry keys.
      for (const key of Object.keys(reducer.expected) as Array<keyof typeof reducer.expected>) {
        if (entry[key] !== reducer.expected[key]) {
          return null;
        }
      }
      return {
        ...reducer.next,
        ...(reducer.clearPending ? { liveModelSwitchPending: undefined } : {}),
      };
  }
  return reducer satisfies never;
}

function reduceSessionEntryPatch(
  operation: SessionEntryPatchStep,
  entry: SessionEntry,
  existingEntry: SessionEntry | undefined,
): Partial<SessionEntry> | null {
  const expected = operation.expected;
  const expectedEntry = operation.kind === "public-fields" ? existingEntry : entry;
  if (
    (expected === null && existingEntry !== undefined) ||
    (expected &&
      (!expectedEntry ||
        expectedEntry.sessionId !== expected.sessionId ||
        (Object.hasOwn(expected, "lifecycleRevision") &&
          expectedEntry.lifecycleRevision !== expected.lifecycleRevision) ||
        (Object.hasOwn(expected, "activeWriterRunId") &&
          expectedEntry.activeWriterRunId !== expected.activeWriterRunId)))
  ) {
    if (operation.kind === "public-fields") {
      throw new Error("Session entry changed before the conditional patch committed");
    }
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
    case "public-fields":
      return preserveGenerationPrivateFields(entry, operation.patch);
    case "ambient-transcript-watermark":
      return projectAmbientTranscriptWatermark(entry, operation.watermark);
    case "compaction-accounting":
      return projectCompactionAccountingPatch(entry, operation.accounting);
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
